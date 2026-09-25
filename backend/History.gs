/**
 * Per-item price history and the "vs the usual price" baseline derived
 * from it, plus the one-time backfill that seeds it.
 */

// --- Price history & baseline ---
//
// Store shape (chunked into ScriptProperties):
//   { version: 1, items: { '<display name>': [['115.08.05', 23.4], ...] } }
// Prices are 元/公斤 wholesale averages — the same measured series as the
// board's `avg_price`. Entries are keyed per BOARD ITEM, not per MOA root,
// because two items can share one root with different variety filters
// (青椒/甜椒, 玉米/玉米筍, 蔥/紅蔥頭, 白花椰菜/青花菜).

/** Parsed history store, or an empty one when absent/torn/corrupt. */
function readHistory() {
  var json = readChunkedProp(HISTORY_PROP_PREFIX, HISTORY_PROP_COUNT);
  if (json) {
    try {
      var parsed = JSON.parse(json);
      if (parsed && parsed.items) return parsed;
    } catch (err) {
      Logger.log('readHistory parse error: ' + err);
    }
  }
  return { version: 1, items: {} };
}

function writeHistory(history) {
  writeChunkedProp(HISTORY_PROP_PREFIX, HISTORY_PROP_COUNT, JSON.stringify(history));
}

/**
 * Serialises history read-modify-write. The 4-hourly refresh and a queued
 * backfill can genuinely overlap; without the lock, whichever writes last
 * silently discards the other's observations.
 */
function withHistoryLock(fn, waitMs) {
  var lock = LockService.getScriptLock();
  lock.waitLock(waitMs || HISTORY_LOCK_WAIT_MS);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Records one (trading date, price) observation per board item. Idempotent
 * per date: the 4-hourly refresh revisits the same trading day and must
 * replace, not duplicate. Items the plausibility guard marked `suspect` are
 * skipped — a flagged observation must not bend the 28-day median, which is
 * the baseline every later "cheaper than usual" claim is measured against.
 * Trimming rides on every write — a rolling window needs no separate cleanup
 * job that could silently die.
 */
function updateHistory(board) {
  if (!board || !board.roc_date || !board.items || !board.items.length) return;
  try {
    withHistoryLock(function () {
      var history = readHistory();
      for (var i = 0; i < board.items.length; i++) {
        var it = board.items[i];
        if (it.suspect) continue;
        history.items[it.name] = appendObservation(history.items[it.name], board.roc_date, it.avg_price);
      }
      pruneHistory(history);
      writeHistory(history);
    });
  } catch (err) {
    // A missed cycle is benign — the same trading date is re-recorded by the
    // next refresh — and a thrown lock timeout must not mask the successful
    // board store in the refresh bookkeeping.
    Logger.log('updateHistory skipped: ' + err);
  }
}

/** Adds or replaces one dated observation, keeping the series sorted and trimmed. */
function appendObservation(series, rocDate, price) {
  var out = (series || []).filter(function (entry) { return entry[0] !== rocDate; });
  out.push([rocDate, price]);
  out.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  return out.slice(-BASELINE_WINDOW);
}

/**
 * Drops entries past the calendar horizon and whole items that left
 * BOARD_ITEMS, so the store stays bounded by construction (~50 KB worst case
 * against the 500 KB properties quota).
 */
function pruneHistory(history) {
  var cutoff = rocDateDaysAgo(BASELINE_HORIZON_DAYS);
  var known = {};
  for (var i = 0; i < BOARD_ITEMS.length; i++) known[BOARD_ITEMS[i].name] = true;
  Object.keys(history.items).forEach(function (name) {
    if (!known[name]) {
      delete history.items[name];
      return;
    }
    var kept = history.items[name].filter(function (entry) { return entry[0] >= cutoff; });
    if (kept.length) {
      history.items[name] = kept;
    } else {
      delete history.items[name];
    }
  });
}

/**
 * ROC date string `days` calendar days before today. Lexicographic comparison
 * of these strings is safe while the ROC year has 3 digits (until 2910).
 */
function rocDateDaysAgo(days) {
  var d = new Date();
  d.setDate(d.getDate() - days);
  return dateToROC(d);
}

/** Median of a non-empty numeric array. */
function median(values) {
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Attaches `baseline_price` (元/台斤) and `vs_baseline_percent` to items with
 * enough recent history. Today's own observation is excluded — the baseline
 * means "the usual price", and a spike day must not vouch for itself. Items
 * short on history simply carry no baseline fields: the frontend treats them
 * as optional, so a cold store degrades to the pre-feature UI.
 */
function applyBaselines(items, history, todayRoc) {
  var cutoff = rocDateDaysAgo(BASELINE_HORIZON_DAYS);
  for (var i = 0; i < items.length; i++) {
    var series = history.items[items[i].name] || [];
    var prices = [];
    for (var j = 0; j < series.length; j++) {
      if (series[j][0] === todayRoc || series[j][0] < cutoff) continue;
      prices.push(series[j][1]);
    }
    if (prices.length < BASELINE_MIN_DAYS) continue;
    attachComparison(items[i], median(prices), 'baseline_price', 'vs_baseline_percent');
  }
}

/**
 * Today's wholesale price against a reference median in 元/公斤: the
 * reference in 元/台斤 under `priceKey`, today's distance from it under
 * `pctKey`. One formula for every comparison the card carries — the 28-day
 * baseline and the same weeks last year — so the drawer's two sentences
 * cannot round or convert differently. Nothing without a positive reference.
 */
function attachComparison(item, base, priceKey, pctKey) {
  if (!(base > 0)) return;
  item[priceKey] = round1(base * CATTY_PER_KG);
  item[pctKey] = percentAgainst(item.avg_price, base);
}

/** How far `today` is from `base`, both 元/公斤, in percent to one decimal. */
function percentAgainst(today, base) {
  return round1(((today - base) / base) * 100);
}

/** Cheap history overview for diag/backfill responses. */
function historySummary() {
  var history = readHistory();
  var names = Object.keys(history.items);
  var minLen = null;
  var maxLen = null;
  for (var i = 0; i < names.length; i++) {
    var len = history.items[names[i]].length;
    if (minLen === null || len < minLen) minLen = len;
    if (maxLen === null || len > maxLen) maxLen = len;
  }
  return { items: names.length, min_days: minLen, max_days: maxLen };
}

// --- History backfill (one-time seeding) ---

/**
 * `?action=backfill` — queues the historical crawl in a one-off trigger and
 * answers at once, exactly like `warm`: the crawl takes minutes and must
 * never run inside the Web App response window. `force=1` jumps the lock.
 */
function handleBackfill(params) {
  // The long-term archive's backfill (#22 §4) is a different job with its own
  // state; it shares the action and the admin gate, nothing else.
  if (params && params.sheet === '1') return handleSheetBackfill(params);
  if (params && params.sheet) {
    // Anything else there is a typo for the archive, and falling through to
    // the rolling seed — and its hour-long queue lock — would be a surprise.
    return { type: 'backfill', sheet: true, queued: false, message: 'sheet 參數只接受 1' };
  }
  var cache = CacheService.getScriptCache();
  if (params && params.force) cache.remove(BACKFILL_LOCK_KEY);
  if (cache.get(BACKFILL_LOCK_KEY)) {
    return { type: 'backfill', queued: false, message: '已有回填排程進行中', history: historySummary() };
  }
  cache.put(BACKFILL_LOCK_KEY, '1', BACKFILL_LOCK_TTL);
  try {
    dropTriggers(BACKFILL_ONCE_FN);
    ScriptApp.newTrigger(BACKFILL_ONCE_FN).timeBased().after(1000).create();
    return { type: 'backfill', queued: true, message: '已排入背景回填，約數分鐘後生效', history: historySummary() };
  } catch (err) {
    Logger.log('handleBackfill error: ' + err);
    cache.remove(BACKFILL_LOCK_KEY);
    return { type: 'backfill', queued: false, message: String(err && err.message || err), history: historySummary() };
  }
}

/** One-off trigger target; the lock keeps repeat taps cheap for its full TTL. */
function backfillHistoryOnce() {
  var result = null;
  try {
    result = backfillHistory();
  } finally {
    // The trigger first, and each guarded on its own. Dropping the queue lock
    // before this trigger is gone leaves a window where a `handleBackfill`
    // re-locks and installs a new one, which this line then deletes: the
    // backfill never runs and the hour-long lock blocks every retry. Guarding
    // both is what keeps either failure from costing the other.
    try {
      dropTriggers(BACKFILL_ONCE_FN);
    } catch (err) {
      Logger.log('backfillHistoryOnce: trigger not dropped: ' + err);
    }
    // A run that merged nothing leaves no queue behind it: the crawl is gone
    // either way, and making the operator wait out the hour to ask again
    // would be a penalty for someone else's lock.
    try {
      if (!result || !result.merged) CacheService.getScriptCache().remove(BACKFILL_LOCK_KEY);
    } catch (err) {
      Logger.log('backfillHistoryOnce: queue lock not cleared: ' + err);
    }
  }
  return result;
}

/**
 * Merges the crawled windows into the history under the lock.
 *
 * `busy` and `failed` are told apart by whether the body ran at all, because
 * only the first is worth retrying: a lock someone else holds clears on its
 * own, and a merge that threw would throw again the same way.
 * @returns {string} 'merged', 'busy' or 'failed'.
 */
function mergeCrawled(crawled) {
  var ran = false;
  try {
    withHistoryLock(function () {
      ran = true;
      var history = readHistory();
      for (var c = 0; c < crawled.length; c++) {
        var rowsByRoot = crawled[c];
        for (var i = 0; i < BOARD_ITEMS.length; i++) {
          var def = BOARD_ITEMS[i];
          var byDate = groupByTransDate(selectRows(rowsByRoot[def.official], def));
          Object.keys(byDate).forEach(function (roc) {
            var day = weightedAverage(byDate[roc]);
            if (day.volume < MIN_TRADE_VOLUME || !(day.avg > 0)) return;
            history.items[def.name] = appendObservation(history.items[def.name], roc, round1(day.avg));
          });
        }
      }
      pruneHistory(history);
      writeHistory(history);
    });
    return 'merged';
  } catch (err) {
    Logger.log(ran ? 'mergeCrawled failed: ' + err : 'mergeCrawled: history lock busy: ' + err);
    return ran ? 'failed' : 'busy';
  }
}

/**
 * Seeds the history with BACKFILL_WINDOWS × BACKFILL_WINDOW_DAYS calendar
 * days of range queries. Merging is per-date idempotent, so re-running is
 * safe and only fills gaps — a throttled window costs coverage, not
 * correctness, and the 4-hourly refresh keeps topping the window up.
 */
function backfillHistory() {
  var roots = boardRoots();
  var today = new Date();

  // Crawl every window BEFORE taking the lock — the fetches are the slow
  // part, and the merge below only needs the lock for milliseconds.
  var crawled = [];
  for (var w = BACKFILL_WINDOWS - 1; w >= 0; w--) {
    var end = new Date(today);
    end.setDate(today.getDate() - w * BACKFILL_WINDOW_DAYS);
    var start = new Date(end);
    start.setDate(end.getDate() - (BACKFILL_WINDOW_DAYS - 1));
    // Retries empty roots once, so one throttled batch cannot silently strip
    // a slice of roots from the one-time seed; and refetches what MOA cut from
    // a root, whose oldest day would otherwise be an average of some markets.
    // A root still unanswered is simply missing, as it always was: the
    // 4-hourly refresh tops the window up.
    //
    // A cut root gets one more request for what MOA cut, not halving until
    // whole: this seed crawls every window in ONE execution, and an open-ended
    // run of refetches could push it past the 6-minute limit and lose the
    // lot. No older window covers those days either, so dropping them would
    // leave the baseline a hole until they aged out.
    var meta = { answered: {}, truncated: {}, unanswered: {} };
    var rows = fetchRootRows(roots, dateToROC(start), dateToROC(end), meta);
    Object.keys(meta.truncated).forEach(function (root) {
      rows[root] = patchTruncated(root, dateToROC(start), rows[root]);
    });
    crawled.push(rows);
  }

  // Retried once, because losing this lock now costs more than it used to: the
  // long-term archive (#22) holds the same lock across a Sheets round trip, so
  // a 30 s wait can genuinely time out — and a thrown timeout here would throw
  // away a crawl that took minutes, behind a one-hour queue lock that stops
  // anyone simply asking again.
  var outcome = mergeCrawled(crawled);
  if (outcome === 'busy') outcome = mergeCrawled(crawled);
  var summary = historySummary();
  summary.merged = outcome === 'merged';
  Logger.log(summary.merged
    ? 'Backfill complete: ' + summary.items + ' items with history'
    : 'Backfill merged nothing (' + outcome + ')');
  return summary;
}
