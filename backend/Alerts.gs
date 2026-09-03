/**
 * Failure alerting. Every decision here is a read-modify-write on shared
 * state, so all of them run inside one script-lock section, and none of them
 * may throw: alerting sits on both the refresh and the serving path.
 */


// --- Failure alerting ---
//
// Every mail decision runs inside ONE lock section, because all of them are
// read-modify-write on shared state: without it a 30-execution burst can turn
// a single incident into 30 emails against a ~100/day quota, and two
// overlapping refreshes can each read the same failure streak.
//
// `withAlertLock` deliberately uses `tryLock`, not `waitLock`: failing to take
// the lock means another execution is already deciding, which is exactly the
// outcome we want. The history writes use `waitLock` instead, because there a
// skipped turn would lose an observation.

/**
 * Runs alert bookkeeping under the script lock and swallows EVERYTHING.
 * Alerting sits on both the refresh and the serving path, so no failure in
 * here — mail quota, ScriptProperties, lock contention — may escape and take
 * the board down with it.
 * @returns {*} the callback's value, or null when it did not run/threw.
 */
function withAlertLock(fn) {
  var lock = null;
  try {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(ALERT_LOCK_WAIT_MS)) return null; // another execution owns this decision
  } catch (err) {
    Logger.log('withAlertLock acquire failed: ' + err);
    return null;
  }
  try {
    return fn();
  } catch (err) {
    Logger.log('alert bookkeeping failed: ' + err);
    return null;
  } finally {
    try {
      lock.releaseLock();
    } catch (err) {
      Logger.log('withAlertLock release failed: ' + err);
    }
  }
}

/**
 * Records one refresh outcome: streak counting, the failure alert and the
 * recovery mail, all in a single atomic section so a concurrent refresh can
 * neither mis-count the streak nor duplicate the mail.
 * @returns {string|null} what it did, for tests and logs.
 */
function recordRefreshOutcome(ok, detail) {
  return withAlertLock(function () {
    var props = PropertiesService.getScriptProperties();

    if (ok) {
      props.setProperty(ALERT_STREAK_PROP, '0');
      if (props.getProperty(ALERT_ACTIVE_PROP) !== '1') return 'ok';
      // Send BEFORE clearing. Clearing first would close the incident even
      // when the mail failed, so the next healthy refresh would skip the
      // all-clear and leave the reader believing the app is still broken.
      MailApp.sendEmail(ALERT_EMAIL, '[VeggieRadar] 已恢復正常', detail + '\n診斷：' + diagUrl() + '\n');
      props.deleteProperty(ALERT_ACTIVE_PROP);
      props.deleteProperty(ALERT_SENT_PROP);
      return 'recovered';
    }

    var streak = (parseInt(props.getProperty(ALERT_STREAK_PROP) || '0', 10) || 0) + 1;
    props.setProperty(ALERT_STREAK_PROP, String(streak));
    if (streak < ALERT_FAILURE_STREAK) return 'counted';
    if (withinCooldown(props)) return 'cooldown';

    MailApp.sendEmail(
      ALERT_EMAIL,
      '[VeggieRadar] 連續 ' + streak + ' 次更新失敗',
      '看板更新連續失敗，使用者看到的行情正在變舊。\n\n' +
      '連續失敗次數：' + streak + '\n' +
      '最後一次失敗原因：' + detail + '\n' +
      '最後一次成功：' + (props.getProperty(LAST_OK_PROP) || '（無記錄）') + '\n\n' +
      '診斷：' + diagUrl() + '\n' +
      '常見原因：MOA 連續節流、交易日 probe 失敗、Apps Script 配額用盡。\n');
    openIncident(props);
    return 'alerted';
  });
}

/**
 * Opens an incident on the SERVING path (board silence), where there is no
 * refresh outcome to attach to. Same atomic section, same cooldown.
 * @returns {boolean} true when a mail was actually sent.
 */
function sendAlert(subject, body) {
  return withAlertLock(function () {
    var props = PropertiesService.getScriptProperties();
    if (withinCooldown(props)) return false;
    MailApp.sendEmail(ALERT_EMAIL, subject, body);
    openIncident(props);
    return true;
  }) === true;
}

/**
 * True while `iso` is inside a `windowMs` window. Shared by the incident
 * cooldown and both probe limiters so all three age identically.
 */
function withinWindow(iso, windowMs) {
  var at = Date.parse(iso || '');
  return !isNaN(at) && Date.now() - at < windowMs;
}

/** True while the current incident window suppresses further alerts. */
function withinCooldown(props) {
  return withinWindow(props.getProperty(ALERT_SENT_PROP), ALERT_COOLDOWN_MS);
}

function openIncident(props) {
  props.setProperty(ALERT_SENT_PROP, new Date().toISOString());
  props.setProperty(ALERT_ACTIVE_PROP, '1');
}

/** Best-effort diag link for alert bodies; never throws. */
function diagUrl() {
  try {
    return ScriptApp.getService().getUrl() + '?action=diag';
  } catch (err) {
    return '(Web App URL 不可用，請於 Apps Script 專案查看)';
  }
}

/**
 * Maps a mail exception to an operator-meaningful CATEGORY. The raw message is
 * logged, never returned: `?action=alerttest` is public and unauthenticated,
 * and Apps Script mail errors can quote the recipient address — the very thing
 * `diag` deliberately withholds. A category is all the operator needs to act.
 */
function classifyMailError(err) {
  var text = String((err && err.message) || err || '');
  Logger.log('alerttest mail failure: ' + text);
  if (/permission|authoriz|scope|consent/i.test(text)) return 'mail_scope_unauthorised';
  if (/quota|limit|exceeded/i.test(text)) return 'mail_quota_exhausted';
  if (/invalid|recipient|address/i.test(text)) return 'recipient_rejected';
  return 'unknown';
}

/**
 * `?action=alerttest` — proves the mail scope is actually authorised, the one
 * thing tests cannot verify. Both limiters are DURABLE timestamps, not cache
 * keys: cache eviction would otherwise re-open this public, unauthenticated
 * endpoint immediately. Incident state is deliberately untouched, so a probe
 * never fakes or suppresses a real alert.
 *
 * A FAILED probe consumes no mail quota, so it arms a short backoff rather
 * than nothing: without one, a loop of failing probes would take the shared
 * script lock over and over and could starve the real silence alert.
 */
function handleAlertTest() {
  var outcome = withAlertLock(function () {
    try {
      var props = PropertiesService.getScriptProperties();
      if (withinWindow(props.getProperty(ALERT_TEST_PROP), ALERT_TEST_INTERVAL_MS)) return { state: 'locked' };
      if (withinWindow(props.getProperty(ALERT_TEST_FAIL_PROP), ALERT_TEST_FAIL_BACKOFF_MS)) return { state: 'backoff' };
      try {
        MailApp.sendEmail(
          ALERT_EMAIL,
          '[VeggieRadar] 測試信（非故障）',
          '這是一封測試信，用來確認警報信管道可用。收到代表故障時你也會收到通知。\n\n診斷：' + diagUrl() + '\n');
      } catch (err) {
        props.setProperty(ALERT_TEST_FAIL_PROP, new Date().toISOString());
        return { state: 'failed', reason: classifyMailError(err) };
      }
      props.setProperty(ALERT_TEST_PROP, new Date().toISOString());
      props.deleteProperty(ALERT_TEST_FAIL_PROP);
      return { state: 'sent' };
    } catch (err) {
      // Bookkeeping itself failed. Reported as a channel failure rather than
      // as contention, so the two stay distinguishable.
      Logger.log('alerttest bookkeeping failed: ' + err);
      return { state: 'failed', reason: 'unknown' };
    }
  });

  if (!outcome) return { type: 'alerttest', sent: false, message: '另一個執行正在處理警報，請稍後再試' };
  if (outcome.state === 'sent') return { type: 'alerttest', sent: true, message: '已寄出測試信' };
  if (outcome.state === 'locked') return { type: 'alerttest', sent: false, message: '測試信已於一小時內寄出' };
  if (outcome.state === 'backoff') return { type: 'alerttest', sent: false, message: '剛才寄送失敗，請稍後再試' };
  return { type: 'alerttest', sent: false, message: '寄信失敗', reason: outcome.reason };
}
