/**
 * The board: building it from MOA, storing it across the fast cache and
 * chunked durable properties, serving it without ever crawling synchronously,
 * and the triggers that keep it fresh.
 */


// --- Board ---

/**
 * Serves the board for user requests. NEVER crawls synchronously — a cold
 * crawl exceeds the Web App response window and returns an error page.
 * Order: in-memory cache → durable ScriptProperties → "warming" placeholder.
 *
 * Anything past `BOARD_MAX_AGE_MS` is served as-is but queues a background
 * rebuild, so the app recovers on its own if the refresh trigger stops firing.
 */
function readBoard() {
  var cache = CacheService.getScriptCache();
  var json = cache.get(BOARD_CACHE_KEY);
  if (!json) {
    json = readDurableBoard();
    if (json) cache.put(BOARD_CACHE_KEY, json, BOARD_CACHE_TTL);
  }
  if (!json) {
    // No data yet — trigger never ran. Fast, non-crawling response.
    scheduleRefresh();
    return { type: 'board', warming: true, stale: true, count: 0, items: [] };
  }

  var board = JSON.parse(json);
  board.cached = true;
  board.age_ms = boardAgeMs(board);
  board.stale = board.age_ms === null || board.age_ms > BOARD_MAX_AGE_MS;
  if (board.stale) board.refresh_queued = scheduleRefresh();
  // A dead trigger produces no failed refreshes to count — only a board that
  // quietly keeps ageing. The serving path is the only thing still executing,
  // so it is what raises that alarm. Cooldown-guarded inside `sendAlert`, and
  // `sendAlert` never throws, so this cannot affect the response.
  if (board.age_ms === null || board.age_ms > ALERT_SILENCE_MS) {
    sendAlert(
      '[VeggieRadar] 看板已停止更新',
      '看板持續變舊，但沒有任何更新失敗記錄 —— 這是排程觸發器消失或壞掉的樣子。\n\n' +
      '交易日：' + (board.roc_date || '（未知）') + '\n' +
      '最後爬取：' + (board.generated_at || '（未知）') + '\n' +
      '已過時間：' + (board.age_ms === null ? '未知' : Math.round(board.age_ms / 3600000) + ' 小時') + '\n\n' +
      '診斷：' + diagUrl() + '\n' +
      '修復：於 Apps Script 專案執行 installDailyTrigger()，並確認 diag 的 triggers 含 refreshBoardCache。\n',
    );
  }
  return board;
}

/**
 * Milliseconds since the board was crawled, or null when the board predates
 * `generated_at` (which counts as stale — its real age is unknown).
 */
function boardAgeMs(board) {
  if (!board || !board.generated_at) return null;
  var built = Date.parse(board.generated_at);
  return isNaN(built) ? null : Math.max(0, Date.now() - built);
}

/**
 * Crawls the MOA API and assembles the board. Slow (many requests) — only ever
 * called from the time-driven trigger / manual setup, never from doGet.
 */
function buildBoard() {
  var dates = resolveTradeDates(true);
  if (!dates.latest) {
    return {
      type: 'board',
      error: '近期查無交易資料',
      generated_at: new Date().toISOString(),
      count: 0,
      items: []
    };
  }

  var roots = boardRoots();
  var today = fetchRootRows(roots, dates.latest);
  var prev = dates.prev ? fetchRootRows(roots, dates.prev) : {};

  var items = [];
  for (var i = 0; i < BOARD_ITEMS.length; i++) {
    var def = BOARD_ITEMS[i];
    var todayRows = selectRows(today[def.official], def);
    if (!todayRows.length) continue;
    var card = aggregateGroup(def, todayRows, selectRows(prev[def.official], def));
    if (card) items.push(card);
  }
  applyBaselines(items, readHistory(), dates.latest);

  return {
    type: 'board',
    date: rocToISO(dates.latest),
    roc_date: dates.latest,
    prev_date: dates.prev,
    // When the backend crawled, as opposed to the trading date above. The UI
    // needs both: a stuck `date` with a moving `generated_at` means 休市, while
    // a frozen `generated_at` means the refresh pipeline is broken.
    generated_at: new Date().toISOString(),
    count: items.length,
    items: items
  };
}

/** Distinct MOA root names to fetch — several board items share one root. */
function boardRoots() {
  var seen = {};
  var roots = [];
  for (var i = 0; i < BOARD_ITEMS.length; i++) {
    var root = BOARD_ITEMS[i].official;
    if (!seen[root]) {
      seen[root] = true;
      roots.push(root);
    }
  }
  return roots;
}

/** Persists a healthy board to the fast cache and to chunked durable properties. */
function storeBoard(payload) {
  var json = JSON.stringify(payload);
  CacheService.getScriptCache().put(BOARD_CACHE_KEY, json, BOARD_CACHE_TTL);
  writeChunkedProp(BOARD_PROP_PREFIX, BOARD_PROP_COUNT, json);
}

/** Reassembles the chunked durable board, or null when absent/incomplete. */
function readDurableBoard() {
  return readChunkedProp(BOARD_PROP_PREFIX, BOARD_PROP_COUNT);
}

/**
 * Writes one JSON string across numbered ScriptProperties chunks (a single
 * value caps at 9 KB), then deletes chunks left over from a larger write so
 * a shrinking payload cannot leak quota.
 */
function writeChunkedProp(prefix, countKey, json) {
  try {
    var props = PropertiesService.getScriptProperties();
    var chunks = Math.ceil(json.length / PROP_CHUNK_SIZE) || 1;
    var write = {};
    for (var i = 0; i < chunks; i++) {
      write[prefix + i] = json.substring(i * PROP_CHUNK_SIZE, (i + 1) * PROP_CHUNK_SIZE);
    }
    write[countKey] = String(chunks);
    props.setProperties(write);

    var existing = props.getProperties();
    for (var key in existing) {
      if (key.indexOf(prefix) !== 0) continue;
      var idx = parseInt(key.substring(prefix.length), 10);
      if (!isNaN(idx) && idx >= chunks) props.deleteProperty(key);
    }
  } catch (err) {
    Logger.log('writeChunkedProp error (' + prefix + '): ' + err);
  }
}

/** Reads a chunked JSON string back, or null when absent or torn. */
function readChunkedProp(prefix, countKey) {
  try {
    var all = PropertiesService.getScriptProperties().getProperties();
    var chunks = parseInt(all[countKey] || '0', 10);
    if (!chunks) return null;
    var parts = [];
    for (var i = 0; i < chunks; i++) {
      var part = all[prefix + i];
      if (part == null) return null; // torn write — treat as missing
      parts.push(part);
    }
    return parts.join('');
  } catch (err) {
    Logger.log('readChunkedProp error (' + prefix + '): ' + err);
    return null;
  }
}

/**
 * Trigger target — rebuilds the board, then publishes it only if it is
 * plausible. An empty build is never stored (a throttled crawl must not wipe a
 * good board) and neither is an implausible one — see `validateBoard`: a board
 * that fails the guard is kept aside under `REJECTED_PROP_PREFIX` for
 * inspection, while the cache, the durable props and the price history keep the
 * board that was already on air. Every outcome is recorded so `?action=diag`
 * can show that refreshes are running and what they decided.
 */
function refreshBoardCache() {
  var board = buildBoard();
  var props = PropertiesService.getScriptProperties();
  var verdict = board.items && board.items.length
    ? validateBoard(board, parseStoredBoard(readDurableBoard()))
    : { ok: false, reasons: [board.error || 'empty board'], suspects: [] };
  // Every refresh leaves a verdict, including an empty build: otherwise
  // `diag` would keep showing the previous run's `ok: true` under a refresh
  // that produced nothing.
  props.setProperty(LAST_VALIDATION_PROP, JSON.stringify({
    at: new Date().toISOString(),
    ok: verdict.ok,
    reasons: verdict.reasons,
    suspects: verdict.suspects
  }));
  if (verdict.ok) {
    markSuspects(board, verdict.suspects);
    storeBoard(board);
    updateHistory(board);
    props.setProperty(LAST_OK_PROP, board.generated_at + ' ' + board.roc_date + ' ' + board.count + ' items');
    // Ask for the mirror deploy now the board exists to mirror — after the
    // store, never before it, and never in the rejected branch below: a deploy
    // publishes whatever `?action=board` answers at the time.
    requestMirrorDeploy();
    recordRefreshOutcome(true,
      '看板已重新建立。\n\n' +
      '交易日：' + board.roc_date + '\n' +
      '品項數：' + board.count + '\n' +
      '完成於：' + board.generated_at + '\n');
  } else {
    var reason = verdict.reasons.join('; ');
    if (board.items && board.items.length) {
      // Kept whole rather than truncated: the numbers MOA answered with are
      // the only evidence of what went wrong, and the chunk machinery already
      // handles a payload far past the 9 KB per-property cap.
      writeChunkedProp(REJECTED_PROP_PREFIX, REJECTED_PROP_COUNT, JSON.stringify(board));
      reason = 'implausible: ' + reason;
    }
    // `recordRefreshOutcome` mails this text after three consecutive
    // failures, so the reasons reach the operator without a second channel.
    props.setProperty(LAST_FAIL_PROP, new Date().toISOString() + ' ' + reason);
    recordRefreshOutcome(false, reason);
  }
  Logger.log('Board refreshed: ' + (board.count || 0) + ' items for ' + (board.roc_date || 'n/a'));
  return board;
}

/**
 * Tells GitHub a new board exists, so the mirror is republished by the crawl
 * rather than by a clock unrelated to it (#68).
 *
 * Mirror age is the board's age when the deploy ran plus everything since, and
 * the second term is not the number the cron says: a schedule asking every
 * 2 h realised a 4.5 h median, hourly realised 4.64 h. `repository_dispatch`
 * is API-triggered and not subject to that throttling, so this collapses both
 * terms — the mirror is published minutes after the board it mirrors exists.
 *
 * Nothing here may touch the crawl. With no token configured it does nothing
 * at all and the schedule stays the fallback, and every failure is logged and
 * swallowed — the same contract the alerting honours.
 * @returns {string} what it did, for tests and logs.
 */
function requestMirrorDeploy() {
  var props;
  var token;
  var lastOk;
  var lastAttempt;
  try {
    props = PropertiesService.getScriptProperties();
    token = props.getProperty(GH_DISPATCH_TOKEN_PROP);
    // Read here, with the token, so every properties read in this function is
    // inside this guard: a transient outage must return from here, not throw
    // into `refreshBoardCache` and cost the crawl its own bookkeeping.
    lastOk = props.getProperty(GH_DISPATCH_OK_PROP);
    lastAttempt = props.getProperty(GH_DISPATCH_PROP);
  } catch (err) {
    Logger.log('requestMirrorDeploy: properties unavailable: ' + err);
    return 'unavailable';
  }
  if (!token) return 'unconfigured'; // deliberate: deploy-pages.yml still has its schedule
  // `?action=warm` is public, and the lock it takes is released when the crawl
  // ends rather than held for its TTL, so a visitor can drive crawls every few
  // minutes. A crawl costs the backend; a deploy costs a minute of CI against
  // Pages' ten-an-hour soft limit.
  //
  // A throttled crawl is dropped, not deferred: the mirror then carries the
  // previous board until the next crawl. That board is at most one window
  // older, which is the trade — and it is recorded, because it is the one
  // state in which the newest board is not the one on the mirror.
  if (withinWindow(lastOk, GH_DISPATCH_MIN_INTERVAL_MS)) {
    return recordDispatch(props, 'throttled');
  }
  // A failed attempt is retried by the next crawl, not by the next visitor:
  // see `GH_DISPATCH_FAIL_BACKOFF_MS`. Deliberately not recorded — the record
  // still holds the failure this is backing off from, which is the more useful
  // thing for `diag` to be showing, and re-stamping it here would extend the
  // backoff for as long as something kept crawling.
  if (withinWindow(dispatchFailedAt(lastAttempt), GH_DISPATCH_FAIL_BACKOFF_MS)) return 'backoff';
  try {
    var response = UrlFetchApp.fetch(GH_DISPATCH_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      payload: JSON.stringify({ event_type: GH_DISPATCH_EVENT }),
      // Handled here rather than thrown: a 401 from an expired PAT is an
      // operator's problem, not a reason to lose a crawl that succeeded.
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code === 204) return recordDispatch(props, 'dispatched'); // 204 is an accepted dispatch
    // Status only. The body is GitHub's, and an error body is the last place
    // to be pasting into a log beside a token that just failed.
    Logger.log('requestMirrorDeploy: GitHub answered ' + code);
    return recordDispatch(props, 'rejected ' + code);
  } catch (err) {
    Logger.log('requestMirrorDeploy failed: ' + err);
    return recordDispatch(props, 'failed');
  }
}

/**
 * Records an attempt — the outcome and when — and returns that outcome.
 *
 * A log line is not enough: an expired PAT would 401 on every crawl, mirror
 * freshness would quietly revert to the fallback cron, and nothing an operator
 * looks at would say so. `diag` reads this back as `mirror_dispatch`. Never
 * throws: the property store is not worth a crawl.
 */
function recordDispatch(props, outcome) {
  var now = new Date().toISOString();
  // The floor's clock first, and guarded separately. Both may be new keys and
  // a rejected board has just written its chunks into the same store, so
  // either write can fail on a full one — under a shared guard the first
  // failure would take the second write with it. Losing the floor lets every
  // later crawl spend another Pages deploy; losing the record costs `diag` a
  // line, which `parseDispatch` reads as "attempted, outcome unknown".
  //
  // Only an accepted dispatch arms the floor: a rejection cost no deploy, and
  // holding the next crawl over it would block the retry that recovers from a
  // transient GitHub error.
  if (outcome === 'dispatched') {
    try {
      props.setProperty(GH_DISPATCH_OK_PROP, now);
    } catch (err) {
      Logger.log('recordDispatch floor failed: ' + err);
    }
  }
  try {
    props.setProperty(GH_DISPATCH_PROP, now + ' ' + outcome);
  } catch (err) {
    Logger.log('recordDispatch failed: ' + err);
  }
  return outcome;
}

/**
 * When the last attempt failed AT GitHub — a rejection or a thrown request —
 * or '' for anything else, a throttle included. Only those two are worth
 * backing off from; the rest cost GitHub nothing.
 */
function dispatchFailedAt(record) {
  var space = (record || '').indexOf(' ');
  if (space === -1) return '';
  var outcome = record.substring(space + 1);
  return outcome === 'failed' || outcome.indexOf('rejected') === 0 ? record.substring(0, space) : '';
}

/** Parses a stored board JSON string, or null when it is absent or corrupt. */
function parseStoredBoard(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (err) {
    Logger.log('parseStoredBoard error: ' + err);
    return null;
  }
}

/**
 * One-off trigger target used by `scheduleRefresh`. A dedicated handler name is
 * what makes spent one-off triggers safely distinguishable from the recurring
 * one, since both report a CLOCK event type.
 */
function refreshBoardCacheOnce() {
  try {
    refreshBoardCache();
  } finally {
    dropTriggers(REFRESH_ONCE_FN);
    CacheService.getScriptCache().remove(REFRESH_LOCK_KEY);
  }
}

/**
 * Queues a background rebuild without making the caller wait for the crawl,
 * which takes minutes and would blow the Web App response window.
 * @returns {boolean} true when this call queued the rebuild.
 */
function scheduleRefresh() {
  var cache = CacheService.getScriptCache();
  if (cache.get(REFRESH_LOCK_KEY)) return false; // rebuild already pending
  cache.put(REFRESH_LOCK_KEY, '1', REFRESH_LOCK_TTL);
  try {
    dropTriggers(REFRESH_ONCE_FN); // never accumulate toward the 20-trigger cap
    ScriptApp.newTrigger(REFRESH_ONCE_FN).timeBased().after(1000).create();
    return true;
  } catch (err) {
    Logger.log('scheduleRefresh error: ' + err);
    cache.remove(REFRESH_LOCK_KEY);
    return false;
  }
}

/** Deletes every project trigger bound to one handler function. */
function dropTriggers(handler) {
  var triggers = ScriptApp.getProjectTriggers();
  var dropped = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() !== handler) continue;
    ScriptApp.deleteTrigger(triggers[i]);
    dropped++;
  }
  return dropped;
}

// --- Setup helper: run once to install the recurring refresh trigger ---
function installDailyTrigger() {
  dropTriggers(REFRESH_CRON_FN);
  ScriptApp.newTrigger(REFRESH_CRON_FN).timeBased().everyHours(REFRESH_INTERVAL_HOURS).create();
  return refreshBoardCache();
}
