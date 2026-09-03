/**
 * Google Apps Script (GAS) backend for VeggieRadar — Board-First Architecture
 *
 * Goal: shoppers open the app and instantly see today's common produce prices
 *       at a glance — green when cheaper, clay when pricier — plus an estimated
 *       traditional-market retail band they can use while standing at the stall.
 *
 * How it works:
 *   - A time-trigger (`refreshBoardCache`) pre-warms a cached board so users
 *     never pay the crawl latency.
 *   - `doGet` (default) returns the cached board instantly, tagged with
 *     `generated_at` (when the backend last crawled) so the client can tell
 *     "markets were closed" apart from "our pipeline is dead". A board older
 *     than `BOARD_MAX_AGE_MS` schedules a background rebuild on the spot, so a
 *     dead trigger self-heals instead of freezing the app on an old date.
 *   - `doGet?action=search&query=<name>` filters the board / falls back to a live query.
 *   - `doGet?action=getTrend&cropName=<name>&days=7` returns a price trend,
 *     served from a shared cache and crawled with ONE range query.
 *   - `doGet?action=warm` queues a rebuild and returns immediately.
 *   - `doGet?action=backfill` queues a one-time history seed for baselines.
 *   - `doGet?action=diag` reports board freshness and trigger state.
 *
 * Data source: Taiwan MOA wholesale market transactions (open data, no key required).
 *   Endpoint : https://data.moa.gov.tw/api/v1/AgriProductsTransType/
 *   Dates    : ROC calendar, e.g. 115.08.26
 *   Prices   : NT$ / kg
 *
 * Two MOA quirks drive the shape of this file:
 *
 *   1. `CropName` is matched as a SUBSTRING of the full `<root>-<variety>` name,
 *      not as a prefix. Querying `蔥` returns 洋蔥 (onion) and 大蒜-蔥蒜; querying
 *      `蘿蔔` returns 胡蘿蔔 (carrot); querying `胡瓜` returns 花胡瓜 (小黃瓜).
 *      Every board item therefore declares the exact `root` it wants, plus an
 *      optional variety include/exclude, and rows are filtered locally.
 *
 *   2. On a day a market is closed — including today before the closing prices
 *      publish — MOA returns placeholder rows with `CropName: "休市"` and zeroed
 *      price/quantity. Those rows must never count as "this date has data".
 */

/**
 * Web App entry point: the `doGet` router and the generic diagnostics
 * surface. Each domain file owns its own action handler; this file only routes
 * and formats.
 */


// --- Web App entry point ---
function doGet(e) {
  var params = (e && e.parameter) || {};
  var action = params.action || 'board';

  try {
    var payload;
    if (action === 'getTrend') {
      payload = handleTrend(params);
    } else if (action === 'search') {
      payload = handleSearch(params);
    } else if (action === 'warm') {
      payload = handleWarm(params);
    } else if (action === 'backfill') {
      payload = handleBackfill(params);
    } else if (action === 'alerttest') {
      payload = handleAlertTest();
    } else if (action === 'diag') {
      payload = handleDiag();
    } else {
      payload = readBoard();
    }
    return jsonOut(payload);
  } catch (err) {
    Logger.log('doGet error: ' + err);
    return jsonOut({ error: '系統錯誤，請稍後再試', message: String(err && err.message || err) });
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** `?action=warm` — queues a rebuild and answers immediately. `force=1` jumps the lock. */
function handleWarm(params) {
  if (params && params.force) CacheService.getScriptCache().remove(REFRESH_LOCK_KEY);
  var queued = scheduleRefresh();
  return {
    type: 'warm',
    queued: queued,
    message: queued ? '已排入背景更新，約一分鐘後生效' : '已有更新排程進行中',
    board: boardSummary()
  };
}

/** `?action=diag` — makes refresh liveness observable without opening the GAS console. */
function handleDiag() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  return {
    type: 'diag',
    now: new Date().toISOString(),
    board: boardSummary(),
    board_items_configured: BOARD_ITEMS.length,
    triggers: handlers,
    refresh_queued: !!CacheService.getScriptCache().get(REFRESH_LOCK_KEY),
    last_refresh_ok: props[LAST_OK_PROP] || null,
    last_refresh_fail: props[LAST_FAIL_PROP] || null,
    history: historySummary(),
    // Alert state, so a silent mailbox can be told apart from a silent
    // pipeline. The recipient address is deliberately not exposed — diag is a
    // public endpoint.
    alert: {
      failure_streak: parseInt(props[ALERT_STREAK_PROP] || '0', 10) || 0,
      incident_open: props[ALERT_ACTIVE_PROP] === '1',
      last_sent: props[ALERT_SENT_PROP] || null,
    },
  };
}

/** Freshness header of the stored board — no items, so it stays cheap to serve. */
function boardSummary() {
  var json = CacheService.getScriptCache().get(BOARD_CACHE_KEY) || readDurableBoard();
  if (!json) return null;
  var board = JSON.parse(json);
  var age = boardAgeMs(board);
  return {
    date: board.date || null,
    roc_date: board.roc_date || null,
    generated_at: board.generated_at || null,
    age_ms: age,
    stale: age === null || age > BOARD_MAX_AGE_MS,
    count: board.count || 0
  };
}
