/**
 * Long-term price history, in a Google Sheet (#22).
 *
 * The ScriptProperties history (`History.gs`) is a rolling 28 trading days,
 * bounded by the 500 KB properties quota, and every "cheaper than usual"
 * claim on the board is measured against it. It stays exactly as it is. This
 * writes one MORE copy, per trading day, into a spreadsheet the deployer owns
 * — which is where 「比去年同期」 and a per-variety baseline have to come from,
 * because neither fits in that quota.
 *
 * Three rules hold this apart from the serving path:
 *
 *   - **Off unless configured.** With no `HISTORY_SHEET_ID` script property
 *     nothing here runs and nothing changes. That is how it ships.
 *   - **Never throws.** It hangs off `refreshBoardCache` after the board is
 *     stored, exactly like the alerting and the mirror dispatch: a Sheets
 *     failure may cost a day of the long archive, never a day of prices.
 *   - **Idempotent per trading day.** The refresh runs every 4 h and revisits
 *     the same day, so a day is written once — and rewritten at most once
 *     more, when the numbers under it have actually moved on.
 */


// --- Long-term history (Google Sheet) ---

/**
 * The row shape, and the reason it is not quite the one the issue sketched.
 *
 * A variety row has no measured volume or market count: `varietyBreakdown`
 * publishes each variety's share and price, and drops the volume it grouped
 * by. Deriving `share × total` would put a number in the archive that nobody
 * measured, so the share is written instead and those two columns stay empty.
 * Anyone who wants the volume can multiply it by the blend row on the same
 * date, and know that they did.
 */
var SHEET_HEADER = ['date', 'item', 'root', 'variety', 'avg_price_kg', 'volume_kg', 'markets', 'share_percent'];

/**
 * Appends one trading day to the long-term Sheet. Safe to call on every
 * refresh: the same day is written once.
 *
 * Runs under the same lock as `updateHistory`, because it is the same kind of
 * read-modify-write and the same two executions can overlap — the 4-hourly
 * trigger and a `?action=warm` rebuild. Sharing that lock means a slow Sheets
 * round trip can cost a concurrent refresh its history update; that refresh
 * already treats a missed cycle as benign, and double-archiving a day is the
 * worse of the two.
 * @returns {string} what it did, for tests and logs.
 */
function appendDailyHistory(board) {
  try {
    return withHistoryLock(function () { return archiveDay(board); });
  } catch (err) {
    // Lock contention only: `archiveDay` swallows its own failures.
    Logger.log('appendDailyHistory skipped: ' + err);
    return 'busy';
  }
}

/** The decision and the write, inside the lock. Never throws. */
function archiveDay(board) {
  var props;
  var sheetId;
  var written;
  try {
    props = PropertiesService.getScriptProperties();
    sheetId = props.getProperty(HISTORY_SHEET_ID_PROP);
    written = props.getProperty(SHEET_LAST_WRITE_PROP);
  } catch (err) {
    Logger.log('archiveDay: properties unavailable: ' + err);
    return 'unavailable';
  }
  if (!sheetId) return 'unconfigured';
  if (!board || !board.date || !board.items || !board.items.length) return 'nothing to write';

  // Was this trading day already archived? The refresh revisits the same day
  // every 4 h, and MOA completes a day's closing prices through the evening,
  // so the same date crawled hours later may be a correction worth keeping —
  // or the same numbers again, which the board keeps serving until the next
  // trading date publishes (all weekend, and longer over a holiday).
  //
  // The first bound is the clock, and it is only there to keep this cheap: a
  // revisit within the window is skipped without reading anything. Past it,
  // what decides is the ROWS — replace when they differ, and do not when they
  // do not. Comparing crawl times instead would either spend a fixed budget
  // of corrections before the evening completion arrived, or rewrite an
  // unchanged Friday every few hours until Monday.
  var last = parseSheetWrite(written);
  var revisit = !!last && last.date === board.date;
  if (revisit && !(Date.parse(board.generated_at || '') - Date.parse(last.generated_at || '') > SHEET_CORRECTION_MS)) {
    return 'already written';
  }

  try {
    // Inside the try with everything else: `historyRowsFor` reads a board the
    // crawl built, and the promise this function makes is that nothing here
    // reaches the caller.
    //
    // Built before anything is deleted: an all-flagged board contributes no
    // rows, and dropping the day for it would leave the archive emptier than
    // the crawl was.
    var rows = historyRowsFor(board);
    if (!rows.length) return 'nothing to write';

    var spreadsheet = SpreadsheetApp.openById(sheetId);
    var sheet = yearSheet(spreadsheet, board.date.substring(0, 4));
    var zone = spreadsheet.getSpreadsheetTimeZone();
    var replacing = false;
    if (revisit) {
      var existing = readDay(sheet, board.date, zone);
      if (sameRows(existing.rows, rows)) {
        // Nothing moved. Recording the crawl time keeps the cheap skip above
        // working, so this read happens once per window rather than per
        // refresh.
        props.setProperty(SHEET_LAST_WRITE_PROP, board.date + ' ' + board.generated_at);
        return 'unchanged';
      }
      if (existing.count) sheet.deleteRows(existing.first, existing.count);
      replacing = true;
    }
    var from = sheet.getLastRow() + 1;
    // `setValues` writes into the grid that exists — it does not grow it, and
    // a default tab is 1000 rows, which ~200 rows a trading day fills in a
    // week. Without this the archive would die on about day five with an
    // out-of-bounds error and nothing else to show for it.
    growFor(sheet, from + rows.length - 1);
    sheet.getRange(from, 1, rows.length, SHEET_HEADER.length).setValues(rows);
    props.setProperty(SHEET_LAST_WRITE_PROP, board.date + ' ' + board.generated_at);
    Logger.log('archiveDay: ' + rows.length + ' rows for ' + board.date + (replacing ? ' (replaced)' : ''));
    return replacing ? 'replaced' : 'appended';
  } catch (err) {
    // A wrong id, a revoked share, an exhausted quota. The board is already
    // stored; this is the archive, and it can miss a day. Nothing is recorded
    // either, so a replacement interrupted between the delete and the write is
    // completed by the next refresh rather than left half-done.
    Logger.log('archiveDay failed: ' + err);
    return 'failed';
  }
}

/**
 * The rows one board contributes: a blend row per item, then a row per
 * variety. Pure, so what gets archived is testable without a spreadsheet.
 *
 * Items the plausibility guard flagged are skipped, for the same reason
 * `updateHistory` skips them: a flagged observation must not bend a baseline,
 * and an archive exists to be measured against later.
 */
function historyRowsFor(board) {
  var rows = [];
  for (var i = 0; i < board.items.length; i++) {
    var it = board.items[i];
    if (it.suspect) continue;
    rows.push([board.date, it.name, it.official_name, '', it.avg_price, it.trade_volume, it.markets_count, '']);
    var varieties = it.varieties || [];
    for (var v = 0; v < varieties.length; v++) {
      // Back to 元/公斤 from the 元/台斤 the card publishes, so every price in
      // this column shares one unit.
      var perKg = round1(varieties[v].catty_price / CATTY_PER_KG);
      rows.push([board.date, it.name, it.official_name, varieties[v].name, perKg, '', '', varieties[v].share_percent]);
    }
  }
  return rows;
}

/**
 * The tab for a calendar year, created with its header if it is not there.
 * One tab per year keeps a single read of "last year, same week" to one
 * range — and keeps any single tab far from the 10 M cell ceiling.
 */
function yearSheet(spreadsheet, year) {
  var sheet = spreadsheet.getSheetByName(year);
  if (sheet) return sheet;
  sheet = spreadsheet.insertSheet(year);
  sheet.getRange(1, 1, 1, SHEET_HEADER.length).setValues([SHEET_HEADER]);
  // The date column is written and read as text. Left as a date, Sheets parses
  // `2026-09-21` into a value it hands back as a `Date`, and `readDay` — which
  // compares dates as strings — would match nothing and duplicate the day it
  // meant to replace. `cellDate` below still tolerates a date cell, for a tab
  // someone reformatted by hand.
  sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  return sheet;
}

/** Grows the tab so `lastNeeded` is inside the grid; `setValues` will not. */
function growFor(sheet, lastNeeded) {
  var max = sheet.getMaxRows();
  if (lastNeeded > max) sheet.insertRowsAfter(max, lastNeeded - max);
}

/**
 * One date's block: where it starts, how long it is, and what is in it. The
 * rows are contiguous — days are only ever appended, and `validateBoard`
 * refuses a board whose trading date went backwards.
 */
function readDay(sheet, date, zone) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { first: 0, count: 0, rows: [] };
  var values = sheet.getRange(2, 1, lastRow - 1, SHEET_HEADER.length).getValues();
  var first = 0;
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    if (cellDate(values[i][0], zone) !== date) continue;
    if (!first) first = i + 2; // 1-based, past the header
    rows.push(values[i]);
  }
  return { first: first, count: rows.length, rows: rows };
}

/** Whether a day's archived rows already say what this crawl would write. */
function sameRows(existing, rows) {
  if (existing.length !== rows.length) return false;
  for (var i = 0; i < rows.length; i++) {
    // From column 1. `readDay` has already matched column 0, and on a tab
    // whose date column holds real dates that cell is a `Date` where the crawl
    // has a string — comparing it would make every day look changed, and the
    // day would be deleted and rewritten every window for as long as the
    // market stayed shut.
    for (var c = 1; c < SHEET_HEADER.length; c++) {
      // Through strings: a number read back from a cell is a number, and the
      // one written may be either.
      if (String(existing[i][c]) !== String(rows[i][c])) return false;
    }
  }
  return true;
}

/**
 * A date cell as `yyyy-MM-dd`. Text comes back as itself; a cell Sheets parsed
 * as a date comes back as a `Date` — an instant, which is only a calendar date
 * in some timezone, and the one that decides is the SPREADSHEET's. Reading it
 * in the script's would put a sheet kept east of Asia/Taipei on the day
 * before, and `readDay` would find nothing to replace.
 */
function cellDate(value, zone) {
  if (!value) return '';
  if (typeof value.getFullYear !== 'function') return String(value);
  return Utilities.formatDate(value, zone, 'yyyy-MM-dd');
}

/** `"<ISO date> <generated_at>"`, or null before the first write. */
function parseSheetWrite(value) {
  if (!value) return null;
  var parts = String(value).split(' ');
  return { date: parts[0] || '', generated_at: parts[1] || '' };
}


// --- Backfill from MOA (#22 §4) ---
//
// The archive starts empty on the day it is configured, and both of its
// readers need what came before: 「比去年同期」 a year of it, a per-variety
// baseline the last 45 days. This fills that in from MOA's range queries, as a
// chain of one-off triggers — one window a link, newest first, so the recent
// weeks a variety baseline needs land in the first minutes and the year-old
// days last.
//
// A backfilled day is built by the SAME code as a crawled one — the board
// item definitions, `aggregateGroup`, the plausibility guard's item rules and
// `historyRowsFor` — so the two cannot drift into different archives. And
// since a day is written once and skipped by date ever after, a window is
// written whole or not at all: a root MOA did not answer fails the window
// (`fetchCompleteRows`), and the next link tries it again.
//
// Three rules keep it from disturbing the live path:
//
//   - **It stops the day before the board's trading date**, fixed when the job
//     starts. The live archive only ever writes that date or a later one (the
//     guard refuses a date going backwards), so the two never write the same
//     day — `archiveDay` appends a new date without looking, and a day both
//     had written would be there twice.
//   - **A day already in the Sheet is left alone.** Whatever wrote it — the
//     live path, or an earlier backfill — got there first. The check is NOT
//     under the lock, and needs no lock only because of the rule above and
//     one chain per job: nothing else writes a date in the job's range. A new
//     writer of past dates would have to take the check under the lock too.
//   - **Its append is under the history lock**, like `archiveDay`'s: two
//     appends computing the same `getLastRow() + 1` would write over each
//     other.
//
// Rows land in the order they were written, not in date order: the live days
// first, then each window newest-first. Nothing reads the tab in order — the
// readers group by date — so sorting column A in the Sheets UI is safe at any
// time; it keeps every day's rows together, which is all `readDay` relies on.

/**
 * `?action=backfill&sheet=1` — behind the admin token, like the rolling
 * backfill (`doGet` gates the action):
 *
 *   - no `months`  → status: the job, and what the Sheet holds. Nothing is
 *                    crawled or queued, so asking is free.
 *   - `months=N`   → starts a job reaching N months back (1–24, default 12),
 *                    skipping what the previous job covered; resumes one of
 *                    that same reach that failed or stalled; reports one that
 *                    is running.
 *   - `cancel=1`   → stops a running job after the window it is on.
 */
function handleSheetBackfill(params) {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty(HISTORY_SHEET_ID_PROP);
  if (!sheetId) return backfillReply(readSheetBackfill(props), false, '尚未設定 HISTORY_SHEET_ID');
  var cancel = params.cancel === '1';
  if (params.months && backfillMonths(params.months) === null) {
    // Refused, not defaulted: `months=0` reads like "nothing", and answering
    // it with a year of crawling is the one reading that costs a day's quota.
    return backfillReply(readSheetBackfill(props), false, 'months 需為 1–' + SHEET_BACKFILL_MAX_MONTHS + ' 的整數');
  }
  if (!params.months && !cancel) {
    var job = readSheetBackfill(props);
    var status = backfillReply(job, false, job ? '回填狀態' : '尚未回填');
    status.archive = archiveSummary(sheetId);
    return status;
  }
  // Serialised, so two requests at once cannot each decide there is no job
  // and start one apiece. Held for property writes and a trigger, never a
  // crawl; it is the history lock because Apps Script has one script lock.
  var ran = false;
  try {
    return withHistoryLock(function () {
      ran = true;
      return cancel ? cancelSheetBackfill(props) : startSheetBackfill(props, params.months);
    });
  } catch (err) {
    if (ran) throw err;
    Logger.log('handleSheetBackfill: lock busy: ' + err);
    return backfillReply(readSheetBackfill(props), false, '系統忙碌中，請稍後再試');
  }
}

function backfillReply(job, queued, message) {
  return { type: 'backfill', sheet: true, queued: queued, message: message, job: job };
}

function cancelSheetBackfill(props) {
  var job = readSheetBackfill(props);
  if (!job || job.status !== 'running') return backfillReply(job, false, '沒有進行中的回填');
  props.setProperty(SHEET_BACKFILL_CANCEL_PROP, job.id);
  job.status = 'cancelled';
  job.updated_at = new Date().toISOString();
  writeSheetBackfill(props, job);
  try {
    dropTriggers(SHEET_BACKFILL_FN);
  } catch (err) {
    Logger.log('cancelSheetBackfill: trigger not dropped: ' + err);
  }
  return backfillReply(job, false, '已停止回填');
}

function startSheetBackfill(props, months) {
  var job = readSheetBackfill(props);
  if (job && job.status === 'running' && !backfillStalled(job)) return backfillReply(job, false, '回填進行中');

  // The same reach resumes; a different one replaces the job, so a failed
  // job is never a dead end.
  var resuming = !!job && (job.status === 'running' || job.status === 'failed') &&
    job.months === backfillMonths(months);
  if (!resuming && job && linkInFlight(job)) {
    // Its last link could still finish and write that job back over this one.
    return backfillReply(job, false, '上一批次仍在執行，請數分鐘後再試');
  }
  if (resuming) {
    // An operator retrying a chain that gave up starts its count again. A
    // chain that merely stalled keeps it: the link that stalled it may have
    // been killed by the 6-minute limit, and a window that always is has to
    // reach `failed` rather than be resumed for ever.
    if (job.status === 'failed') job.failures = 0;
  } else {
    var board = parseStoredBoard(readDurableBoard());
    if (!board || !board.roc_date) return backfillReply(job, false, '尚無看板，無法決定回填終點');
    job = newSheetBackfill(board.roc_date, months, job);
  }
  job.status = 'running';
  job.updated_at = new Date().toISOString();
  // Written before the trigger exists, so the first link cannot read the job
  // this replaces.
  writeSheetBackfill(props, job);
  try {
    dropTriggers(SHEET_BACKFILL_FN);
    ScriptApp.newTrigger(SHEET_BACKFILL_FN).timeBased().after(1000).create();
  } catch (err) {
    Logger.log('startSheetBackfill: not queued: ' + err);
    job.status = 'failed';
    job.last_error = 'not queued: ' + String(err && err.message || err);
    writeSheetBackfill(props, job);
    return backfillReply(job, false, job.last_error);
  }
  return backfillReply(job, true, resuming ? '已從 ' + job.cursor + ' 繼續回填' : '已排入背景回填');
}

/**
 * A fresh job reaching `months` back from the day before `boardRoc`. What the
 * `previous` job finished is skipped rather than crawled again: every day in
 * it is already written, and re-crawling a year to learn that would spend
 * most of a day's trigger runtime on nothing.
 */
function newSheetBackfill(boardRoc, months, previous) {
  var n = backfillMonths(months);
  var last = rocToISO(shiftROC(boardRoc, -1));
  var now = new Date().toISOString();
  return {
    id: now, // tells a link its job from one that replaced it while it ran
    status: 'running',
    months: n,
    from: rocToISO(monthsBefore(boardRoc, n)),
    to: last,
    cursor: last, // the newest day not yet done; the next window ends here
    skip: coveredBy(previous),
    started_at: now,
    updated_at: now,
    link_started_at: null,
    link_open: false,
    windows: 0,
    days_written: 0,
    days_skipped: 0,
    rows_written: 0,
    failures: 0,
    last_error: null
  };
}

/** The requested reach — a year when absent, clamped above — or null when unreadable. */
function backfillMonths(months) {
  if (months === undefined || months === null || months === '') return SHEET_BACKFILL_DEFAULT_MONTHS;
  if (!/^\d+$/.test(String(months))) return null;
  var n = parseInt(months, 10);
  if (n < 1) return null;
  return n > SHEET_BACKFILL_MAX_MONTHS ? SHEET_BACKFILL_MAX_MONTHS : n;
}

/** Whether the job's last link may still be running, and so still write it. */
function linkInFlight(job) {
  var at = Date.parse(job.link_started_at || '');
  return !!job.link_open && !isNaN(at) && Date.now() - at < SHEET_BACKFILL_LINK_MAX_MS;
}

/**
 * The same day `n` months earlier, or that month's last day when it is
 * shorter: 03-31 less one month is 02-28, where `setMonth` alone would roll
 * on to 03-03 and quietly shorten the reach.
 */
function monthsBefore(roc, n) {
  var d = rocToDate(roc);
  var day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  var monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, monthEnd));
  return dateToROC(d);
}

/**
 * The range a job being replaced leaves covered: what it wrote itself —
 * everything after its cursor — joined to the range it was itself told to
 * skip when the two meet, so coverage carries across any number of jobs
 * rather than only the last. Null when there is none.
 */
function coveredBy(job) {
  if (!job || !job.cursor) return null;
  var cursorNext = rocToISO(shiftROC(isoToROC(job.cursor), 1));
  var from = cursorNext > job.from ? cursorNext : job.from;
  var own = from <= job.to ? { from: from, to: job.to } : null;
  var prior = job.skip || null;
  if (!own || !prior) return own || prior;
  var meets = prior.to >= rocToISO(shiftROC(isoToROC(own.from), -1)) &&
    prior.from <= rocToISO(shiftROC(isoToROC(own.to), 1));
  if (!meets) return own; // disjoint: keep the newer, which the next job meets first
  return {
    from: prior.from < own.from ? prior.from : own.from,
    to: prior.to > own.to ? prior.to : own.to
  };
}

/**
 * One link of the chain: one window crawled and written, then the next link
 * queued. Never throws — a trigger that throws is just a stopped chain with
 * nothing recorded about why.
 */
function sheetBackfillStep() {
  var props;
  var job;
  try {
    props = PropertiesService.getScriptProperties();
    job = readSheetBackfill(props);
  } catch (err) {
    // Nothing to record it in. The trigger stays, spent, until the next
    // `months=` request drops it; the job reads as stalled and resumes.
    Logger.log('sheetBackfillStep: properties unavailable: ' + err);
    return null;
  }
  if (job && job.status === 'running' && linkInFlight(job)) {
    // A second link of the same job — a watchdog that fired beside a link
    // that is alive after all. Touch nothing: the triggers are that link's.
    Logger.log('sheetBackfillStep: another link of this job is running');
    return job;
  }
  if (!job || job.status !== 'running' || cancelRequested(props, job)) {
    finishBackfillStep(props, job);
    return job;
  }
  if ((job.failures || 0) >= SHEET_BACKFILL_MAX_FAILURES) {
    // The previous links were counted and never reported back: killed by the
    // execution limit, most likely, which no `catch` survives.
    job.status = 'failed';
    job.last_error = job.last_error || 'the last ' + job.failures + ' links did not finish';
    finishBackfillStep(props, job);
    return job;
  }
  try {
    // Counted BEFORE the work, and cleared by a window that succeeds: a link
    // the 6-minute limit kills never reaches its `catch` or its `finally`.
    job.failures = (job.failures || 0) + 1;
    // Also the heartbeat: a link in flight must not look like a stalled chain
    // to a `months=` request, which would queue a second one beside it, nor
    // be replaced by a new job it could then write back over.
    job.updated_at = new Date().toISOString();
    job.link_started_at = job.updated_at;
    job.link_open = true;
    writeSheetBackfill(props, job);
    armBackfillWatchdog();
    backfillWindow(job, props.getProperty(HISTORY_SHEET_ID_PROP));
  } catch (err) {
    job.last_error = String(err && err.message || err).substring(0, 200);
    Logger.log('sheetBackfillStep failed (' + job.failures + '): ' + err);
    if (job.failures >= SHEET_BACKFILL_MAX_FAILURES) job.status = 'failed';
  } finally {
    finishBackfillStep(props, job);
  }
  return job;
}

/**
 * Records the link and queues the next — unless the job was cancelled or
 * replaced while this link ran, in which case what is stored now is someone
 * else's decision and this link's progress is dropped with it.
 */
function finishBackfillStep(props, job) {
  var stored = null;
  try {
    stored = readSheetBackfill(props);
  } catch (err) {
    Logger.log('finishBackfillStep: job unreadable: ' + err);
  }
  var ours = !!job && !!stored && stored.id === job.id;
  if (ours && cancelRequested(props, job)) {
    // Keep the cancel — even over a window that just finished the job — and
    // drop this link's progress with it: the operator was told it stopped.
    // What the link wrote is in the Sheet all the same, and skipped next time.
    job = stored;
    job.status = 'cancelled';
  }
  // Another job's link is queued: its trigger has this handler's name, so
  // dropping ours would drop that one too.
  var other = !!stored && !ours && stored.status === 'running' && !cancelRequested(props, stored);
  if (ours) {
    job.updated_at = new Date().toISOString();
    job.link_open = false;
    try {
      writeSheetBackfill(props, job);
    } catch (err) {
      Logger.log('finishBackfillStep: job not recorded: ' + err);
    }
  }
  if (!other) {
    try {
      dropTriggers(SHEET_BACKFILL_FN);
    } catch (err) {
      Logger.log('finishBackfillStep: trigger not dropped: ' + err);
    }
  }
  if (ours && job.status === 'running') {
    try {
      // A failed window waits before it is retried, longer each time.
      var wait = job.failures ? SHEET_BACKFILL_RETRY_MS * job.failures : 1000;
      ScriptApp.newTrigger(SHEET_BACKFILL_FN).timeBased().after(wait).create();
    } catch (err) {
      // The chain stops here, and `months=` resumes it once it reads as
      // stalled. Nothing is lost: the cursor already says where it got to.
      Logger.log('finishBackfillStep: next link not queued: ' + err);
    }
  }
}

/**
 * Replaces this link's spent trigger with one that fires once the link could
 * no longer be running. A link that finishes drops it and queues the next as
 * usual; one the 6-minute limit kills, whose `finally` never runs, is followed
 * by the watchdog instead — which finds the failure it counted and retries,
 * so a window that is always too slow reaches `failed` without anyone asking.
 */
function armBackfillWatchdog() {
  try {
    dropTriggers(SHEET_BACKFILL_FN);
    ScriptApp.newTrigger(SHEET_BACKFILL_FN).timeBased().after(SHEET_BACKFILL_LINK_MAX_MS + 60 * 1000).create();
  } catch (err) {
    // Without it a killed link stalls the chain, and `months=` resumes it.
    Logger.log('armBackfillWatchdog: not armed: ' + err);
  }
}

function cancelRequested(props, job) {
  try {
    return !!job && props.getProperty(SHEET_BACKFILL_CANCEL_PROP) === job.id;
  } catch (err) {
    return false;
  }
}

/**
 * Crawls and writes the window ending at `job.cursor`, then moves the cursor
 * past it. Throws on anything that should be retried: a crawl MOA did not
 * fully answer, an unset or unreachable Sheet.
 */
function backfillWindow(job, sheetId) {
  if (!sheetId) throw new Error('HISTORY_SHEET_ID is not set');
  var from = isoToROC(job.from);
  var end = isoToROC(job.cursor);
  var skip = job.skip ? { from: isoToROC(job.skip.from), to: isoToROC(job.skip.to) } : null;

  if (skip && end >= skip.from && end <= skip.to) {
    // Written by the job before this one: step over it without a crawl.
    moveBackfillCursor(job, shiftROC(skip.from, -1));
    job.failures = 0;
    return;
  }
  var start = shiftROC(end, -(BACKFILL_WINDOW_DAYS - SHEET_BACKFILL_CONTEXT_DAYS - 1));
  if (start < from) start = from;
  if (skip && end > skip.to && start <= skip.to) start = shiftROC(skip.to, 1);

  var fetched = fetchCompleteRows(boardRoots(), shiftROC(start, -SHEET_BACKFILL_CONTEXT_DAYS), end);
  if (fetched.unanswered.length) {
    throw new Error('MOA did not answer ' + fetched.unanswered.length + ' roots (' +
      fetched.unanswered.slice(0, 3).join('、') + (fetched.unanswered.length > 3 ? '…' : '') + ')');
  }
  var built = backfillDays(fetched.rows, start, end, fetched.dropped[PROBE_ROOT]);
  // MOA answers a closed market with `休市` rows, so a probe root with no rows
  // at all is a crawl that failed, not a window without trading.
  if (built === null) throw new Error('no ' + PROBE_ROOT + ' rows for ' + start + '–' + end);

  var written = writeArchivedDays(sheetId, built.days, job.id);
  job.windows += 1;
  job.days_written += written.days;
  job.days_skipped += written.skipped;
  job.rows_written += written.rows;
  job.failures = 0;
  job.last_error = null;
  moveBackfillCursor(job, built.deferred || shiftROC(start, -1));
}

function moveBackfillCursor(job, roc) {
  job.cursor = rocToISO(roc);
  if (roc < isoToROC(job.from)) job.status = 'done';
}

/**
 * The archive rows for each trading day in [rocStart, rocEnd], built from one
 * range crawl exactly as the live path builds a day: `aggregateGroup` against
 * the previous trading day, the guard's item rules, then `historyRowsFor`.
 * Rows dated before `rocStart` are only ever that previous day. Pure.
 *
 * The oldest day in the window has no previous trading day in hand when a
 * closure longer than the context days sits right before it. It is not
 * written unjudged: it is returned as `deferred`, and the caller ends the next
 * window on it, where the window's own days lie behind it. The newest day is
 * never deferred — the next window would end on it again — and is judged
 * against nothing, as the live path does after a closure past its lookback.
 *
 * `probeDropped` are days the probe root truncated on alone, so they are
 * missing from its rows. More than a thousand rows of it is trading by any
 * measure, and leaving such a day out of the calendar would make the next
 * day's "previous trading day" the one before it.
 * @returns {{days: Array<{date: string, rows: Array}>, deferred: ?string}|null}
 *   null when the probe root answered nothing at all — a failed crawl, which
 *   must not pass for a week of closed markets.
 */
function backfillDays(rowsByRoot, rocStart, rocEnd, probeDropped) {
  var probeRows = rowsByRoot[PROBE_ROOT];
  if ((!probeRows || !probeRows.length) && !(probeDropped && probeDropped.length)) return null;
  var trading = tradingDates(probeRows || []);
  (probeDropped || []).forEach(function (day) {
    if (trading.indexOf(day) === -1) trading.push(day);
  });
  trading.sort();
  // One map of root → rows per date, which is the shape `boardCards` takes.
  var byDay = {};
  Object.keys(rowsByRoot).forEach(function (root) {
    var grouped = groupByTransDate(rowsByRoot[root]);
    Object.keys(grouped).forEach(function (day) {
      (byDay[day] = byDay[day] || {})[root] = grouped[day];
    });
  });

  var days = [];
  var deferred = null;
  for (var t = 0; t < trading.length; t++) {
    var day = trading[t];
    if (day < rocStart || day > rocEnd) continue;
    var prev = t > 0 ? trading[t - 1] : null;
    if (!prev && day !== rocEnd) {
      deferred = day;
      continue;
    }
    var board = { date: rocToISO(day), items: boardCards(byDay[day] || {}, (prev && byDay[prev]) || {}) };
    // Item rules only. The board-level rules judge a crawl against the board
    // users are looking at, and there is no such board for a day in the past.
    markSuspects(board, validateBoard(board, null).suspects);
    var rows = historyRowsFor(board);
    if (rows.length) days.push({ date: board.date, rows: rows });
  }
  return { days: days, deferred: deferred };
}

/**
 * Appends every day not already in the Sheet, one block per year tab. Each
 * day's rows stay together, which `readDay` relies on.
 *
 * Which days are present is read OUTSIDE the history lock: nothing else can
 * be writing them — the live archive only writes the board's date or later,
 * past this job's end, and one job has one chain. The append is inside it,
 * because the live archive appends too, and two appends computing the same
 * `getLastRow() + 1` would write over each other. That keeps the lock to the
 * write, where reading a year's column under it would hold up the refresh.
 * @returns {{days: number, skipped: number, rows: number}}
 */
function writeArchivedDays(sheetId, days, jobId) {
  var spreadsheet = SpreadsheetApp.openById(sheetId);
  var zone = spreadsheet.getSpreadsheetTimeZone();
  var cache = CacheService.getScriptCache();
  var written = { days: 0, skipped: 0, rows: 0 };
  var byYear = {};
  for (var i = 0; i < days.length; i++) {
    var year = days[i].date.substring(0, 4);
    (byYear[year] = byYear[year] || []).push(days[i]);
  }
  var blocks = [];
  Object.keys(byYear).forEach(function (year) {
    var present = presentDates(spreadsheet, year, zone, jobId, cache);
    var block = [];
    var dates = [];
    byYear[year].forEach(function (day) {
      if (present[day.date]) {
        written.skipped += 1;
        return;
      }
      Array.prototype.push.apply(block, day.rows);
      dates.push(day.date);
      written.days += 1;
    });
    if (block.length) blocks.push({ year: year, rows: block, dates: dates, present: present });
  });
  if (!blocks.length) return written;

  var ran = false;
  var append = function () {
    ran = true;
    for (var b = 0; b < blocks.length; b++) {
      var sheet = yearSheet(spreadsheet, blocks[b].year);
      var from = sheet.getLastRow() + 1;
      growFor(sheet, from + blocks[b].rows.length - 1);
      sheet.getRange(from, 1, blocks[b].rows.length, SHEET_HEADER.length).setValues(blocks[b].rows);
    }
  };
  try {
    withHistoryLock(append);
  } catch (err) {
    if (ran) throw err;
    // Once more, as `backfillHistory` does: the live refresh holds this lock
    // across its own Sheets round trip, and giving up here would throw away
    // a crawl that took a minute.
    Logger.log('writeArchivedDays: history lock busy, retrying once: ' + err);
    withHistoryLock(append);
  }
  for (var r = 0; r < blocks.length; r++) {
    written.rows += blocks[r].rows.length;
    for (var d = 0; d < blocks[r].dates.length; d++) blocks[r].present[blocks[r].dates[d]] = true;
    rememberPresent(cache, jobId, blocks[r].year, blocks[r].present);
  }
  return written;
}

/**
 * The dates a year tab holds, read once per job and then kept in the cache
 * with the job's own writes added — a year's column is ~50k cells, and a job
 * has ~40 links. Safe for the reason the unlocked check is (see the top of
 * this section): no one else writes a date in the job's range. An evicted
 * entry is simply read again.
 */
function presentDates(spreadsheet, year, zone, jobId, cache) {
  var key = SHEET_PRESENT_CACHE_PREFIX + jobId + '_' + year;
  try {
    var hit = jobId && cache.get(key);
    if (hit) return JSON.parse(hit);
  } catch (err) {
    Logger.log('presentDates: cache unreadable: ' + err);
  }
  var tab = spreadsheet.getSheetByName(year);
  var present = tab ? archivedDates(tab, zone) : {};
  rememberPresent(cache, jobId, year, present);
  return present;
}

function rememberPresent(cache, jobId, year, present) {
  if (!jobId) return;
  try {
    cache.put(SHEET_PRESENT_CACHE_PREFIX + jobId + '_' + year, JSON.stringify(present), SHEET_PRESENT_CACHE_TTL);
  } catch (err) {
    Logger.log('rememberPresent: not cached: ' + err); // read again next link
  }
}

/** Every date a year tab holds, as a set. Reads column A only. */
function archivedDates(sheet, zone) {
  var present = {};
  var last = sheet.getLastRow();
  if (last < 2) return present;
  var cells = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < cells.length; i++) present[cellDate(cells[i][0], zone)] = true;
  return present;
}

/**
 * What the archive holds: rows, trading days, and the first and last date.
 * Reads the Sheet, so it is behind the admin token — `diag` is public and
 * reports the job from the properties alone.
 */
function archiveSummary(sheetId) {
  try {
    var spreadsheet = SpreadsheetApp.openById(sheetId);
    var zone = spreadsheet.getSpreadsheetTimeZone();
    var rows = 0;
    var dates = {};
    var tabs = spreadsheet.getSheets();
    for (var i = 0; i < tabs.length; i++) {
      if (!/^\d{4}$/.test(tabs[i].getName())) continue;
      var last = tabs[i].getLastRow();
      if (last < 2) continue;
      rows += last - 1;
      var present = archivedDates(tabs[i], zone);
      for (var d in present) dates[d] = true;
    }
    var sorted = Object.keys(dates).sort();
    return {
      rows: rows,
      days: sorted.length,
      first_date: sorted[0] || null,
      last_date: sorted[sorted.length - 1] || null
    };
  } catch (err) {
    Logger.log('archiveSummary failed: ' + err);
    return { error: String(err && err.message || err) };
  }
}

function backfillStalled(job) {
  var at = Date.parse(job.updated_at || '');
  return isNaN(at) || Date.now() - at > SHEET_BACKFILL_STALL_MS;
}

function readSheetBackfill(props) {
  return parseSheetBackfill(props.getProperty(SHEET_BACKFILL_PROP));
}

function parseSheetBackfill(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    Logger.log('parseSheetBackfill: unreadable job: ' + err);
    return null;
  }
}

function writeSheetBackfill(props, job) {
  props.setProperty(SHEET_BACKFILL_PROP, JSON.stringify(job));
}

/**
 * The job as `diag` publishes it: progress only. `last_error` stays behind the
 * token — it is the platform's text, and can quote whatever Sheets or MOA said.
 */
function publicBackfill(job) {
  if (!job) return null;
  return {
    status: job.status,
    from: job.from,
    to: job.to,
    cursor: job.cursor,
    windows: job.windows,
    days_written: job.days_written,
    rows_written: job.rows_written,
    failures: job.failures,
    updated_at: job.updated_at
  };
}
