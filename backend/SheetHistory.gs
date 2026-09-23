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
    var from = appendRow(sheet);
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
  writeHeader(sheet);
  return sheet;
}

/**
 * The row an append starts at. An empty tab gets its header first, even one
 * that already existed: a write that failed right after `insertSheet` leaves
 * one behind, and every reader here takes row 1 to be the header. Checked
 * here, where the row count is read anyway, so the live path pays no extra
 * Sheets call for it.
 */
function appendRow(sheet) {
  var last = sheet.getLastRow();
  if (last > 0) return last + 1;
  writeHeader(sheet);
  return 2;
}

function writeHeader(sheet) {
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
  // Column A to find the block, then the block alone: this runs under the
  // history lock, and a backfilled year is ~50k rows — all eight columns of
  // it would be 400k cells read to rewrite a couple of hundred.
  var dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var first = 0;
  var count = 0;
  for (var i = 0; i < dates.length; i++) {
    if (cellDate(dates[i][0], zone) !== date) continue;
    if (!first) first = i + 2; // 1-based, past the header
    count++;
  }
  if (!count) return { first: 0, count: 0, rows: [] };
  return { first: first, count: count, rows: sheet.getRange(first, 1, count, SHEET_HEADER.length).getValues() };
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
  var cancel = params.cancel === '1';
  // A cancel needs no sheet: clearing the property is a natural way to stop
  // archiving, and the job it leaves running must still be stoppable.
  if (!sheetId && !cancel) return backfillReply(readSheetBackfill(props), false, '尚未設定 HISTORY_SHEET_ID');
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
  var sheetId = props.getProperty(HISTORY_SHEET_ID_PROP);
  var job = readSheetBackfill(props);
  if (job && job.status === 'running' && !backfillStalled(job)) return backfillReply(job, false, '回填進行中');

  // The same reach resumes; a different one replaces the job, so a failed
  // job is never a dead end.
  var resuming = !!job && (job.status === 'running' || job.status === 'failed') &&
    job.months === backfillMonths(months) && job.sheet === sheetId;
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
    job = newSheetBackfill(board.roc_date, months, job, sheetId);
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
function newSheetBackfill(boardRoc, months, previous, sheetId) {
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
    // Coverage is a fact about ONE spreadsheet: pointed at a new one, the
    // previous job's range was never written there.
    sheet: sheetId,
    skip: previous && previous.sheet === sheetId ? coveredBy(previous) : [],
    started_at: now,
    updated_at: now,
    link_started_at: null,
    link_open: false,
    windows: 0,
    days_written: 0,
    days_skipped: 0,
    days_rejected: 0,
    rows_written: 0,
    failures: 0,
    last_error: null,
    rejected: [], // the last few days the guard refused, with its reasons
    gaps: [], // windows MOA kept answering with nothing at all
    partial: [], // windows written without a crop MOA kept refusing
    verdict: null // how MOA has answered the window at the cursor, and how often
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
 * The ranges a job being replaced leaves covered: what it wrote itself —
 * everything after its cursor — and the ranges it was itself told to skip,
 * merged where they meet. A list, so coverage carries across any number of
 * jobs, however their ranges fall.
 */
function coveredBy(job) {
  if (!job || !job.cursor) return [];
  var ranges = (job.skip || []).slice();
  var cursorNext = rocToISO(shiftROC(isoToROC(job.cursor), 1));
  var from = cursorNext > job.from ? cursorNext : job.from;
  if (from <= job.to) ranges.push({ from: from, to: job.to });
  return mergeRanges(ranges);
}

/**
 * Date ranges sorted and joined where they overlap or touch. The newest ten
 * are kept: the list lives in a property, and the newest are what a new job
 * meets first.
 */
function mergeRanges(ranges) {
  var sorted = ranges.slice().sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; });
  var out = [];
  for (var i = 0; i < sorted.length; i++) {
    var last = out[out.length - 1];
    if (last && sorted[i].from <= rocToISO(shiftROC(isoToROC(last.to), 1))) {
      if (sorted[i].to > last.to) last.to = sorted[i].to;
    } else {
      out.push({ from: sorted[i].from, to: sorted[i].to });
    }
  }
  return out.slice(-10);
}

/**
 * One link of the chain: one window crawled and written, then the next link
 * queued. Never throws — a trigger that throws is just a stopped chain with
 * nothing recorded about why.
 */
function sheetBackfillStep() {
  var props;
  try {
    props = PropertiesService.getScriptProperties();
  } catch (err) {
    // Nothing to record it in. The trigger stays, spent, until the next
    // `months=` request drops it; the job reads as stalled and resumes.
    Logger.log('sheetBackfillStep: properties unavailable: ' + err);
    return null;
  }
  // Whether this link runs is decided under the lock. Two links deciding at
  // once — a late trigger beside a resume — could each find the job free and
  // write the same window twice, since which days are present is read
  // outside the lock (`writeArchivedDays`).
  var begun;
  var ran = false;
  try {
    begun = withHistoryLock(function () {
      ran = true;
      return beginBackfillLink(props);
    });
  } catch (err) {
    Logger.log('sheetBackfillStep: not begun: ' + err);
    if (!ran) {
      // Busy. A spare link in a minute is harmless: whichever begins second
      // finds the other in flight and leaves.
      try {
        ScriptApp.newTrigger(SHEET_BACKFILL_FN).timeBased().after(60 * 1000).create();
      } catch (err2) {
        Logger.log('sheetBackfillStep: not requeued: ' + err2);
      }
    }
    return null;
  }
  var job = begun.job;
  if (begun.action === 'leave') return job;
  if (begun.action === 'finish') {
    finishBackfillStep(props, job);
    return job;
  }
  try {
    backfillWindow(job, job.sheet);
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
 * The start of a link, under the lock: whether it runs, and if it does, the
 * job marked as having a link in flight.
 * @returns {{action: string, job: Object}} `leave` — another link of this job
 *   is running, touch nothing; `finish` — nothing to do but tidy up; `work`.
 */
function beginBackfillLink(props) {
  var job = readSheetBackfill(props);
  if (job && job.status === 'running' && linkInFlight(job)) {
    // A watchdog that fired beside a link that is alive after all. The
    // triggers are that link's.
    Logger.log('sheetBackfillStep: another link of this job is running');
    return { action: 'leave', job: job };
  }
  if (!job || job.status !== 'running' || cancelRequested(props, job)) return { action: 'finish', job: job };
  if (props.getProperty(HISTORY_SHEET_ID_PROP) !== job.sheet) {
    // Pointed elsewhere, or cleared, mid-job. Its cursor, its coverage and its
    // cached dates are all about the spreadsheet it started on; carrying on
    // into another would leave that one with holes the job calls covered.
    job.status = 'failed';
    job.last_error = 'HISTORY_SHEET_ID changed since this job started; start a new one';
    return { action: 'finish', job: job };
  }
  if ((job.failures || 0) >= SHEET_BACKFILL_MAX_FAILURES) {
    // The previous links were counted and never reported back: killed by the
    // execution limit, most likely, which no `catch` survives.
    job.status = 'failed';
    job.last_error = job.last_error || 'the last ' + job.failures + ' links did not finish';
    return { action: 'finish', job: job };
  }
  // Counted BEFORE the work, and cleared by a window that succeeds: a link
  // the 6-minute limit kills never reaches its `catch` or its `finally`.
  job.failures = (job.failures || 0) + 1;
  // Also the heartbeat: a link in flight must not look like a stalled chain
  // to a `months=` request, nor be replaced by a job it could write back over.
  job.updated_at = new Date().toISOString();
  job.link_started_at = job.updated_at;
  job.link_open = true;
  writeSheetBackfill(props, job);
  armBackfillWatchdog();
  return { action: 'work', job: job };
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
    // Unknowable whose job is stored, so nothing is safe to drop or queue.
    // The watchdog, if this link armed one, will retry past the limit.
    Logger.log('finishBackfillStep: job unreadable; leaving the triggers: ' + err);
    return;
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
  var recorded = true;
  if (ours) {
    job.updated_at = new Date().toISOString();
    job.link_open = false;
    try {
      writeSheetBackfill(props, job);
    } catch (err) {
      // The stored job still reads as a link in flight, so a next link queued
      // now would take itself for a duplicate and stop. Leave the watchdog
      // instead: by the time it fires that link is past the limit, and it
      // retries the window, whose days are skipped if they were written.
      recorded = false;
      Logger.log('finishBackfillStep: job not recorded; leaving the watchdog: ' + err);
    }
  }
  if (!recorded) return;
  if (!other) {
    try {
      dropTriggers(SHEET_BACKFILL_FN);
    } catch (err) {
      Logger.log('finishBackfillStep: trigger not dropped: ' + err);
    }
  }
  if (ours && job.status === 'running') {
    try {
      // A failed window waits before it is retried, longer each time — by the
      // failures or by MOA's repeated answers, whichever is further along —
      // and never as long as the stall window, which it must not look like.
      var v = job.verdict && job.verdict.cursor === job.cursor ? job.verdict.tries : 0;
      var tries = Math.min(Math.max(job.failures || 0, v), 2);
      var wait = tries ? SHEET_BACKFILL_RETRY_MS * tries : 1000;
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
  var skips = (job.skip || []).map(function (r) { return { from: isoToROC(r.from), to: isoToROC(r.to) }; });

  for (var k = 0; k < skips.length; k++) {
    if (end >= skips[k].from && end <= skips[k].to) {
      // Written by a job before this one: step over it without a crawl.
      moveBackfillCursor(job, shiftROC(skips[k].from, -1));
      job.failures = 0;
      return;
    }
  }
  var start = shiftROC(end, -(BACKFILL_WINDOW_DAYS - SHEET_BACKFILL_CONTEXT_DAYS - 1));
  if (start < from) start = from;
  for (var m = 0; m < skips.length; m++) {
    if (end > skips[m].to && start <= skips[m].to) start = shiftROC(skips[m].to, 1);
  }

  var fetched = fetchCompleteRows(boardRoots(), shiftROC(start, -SHEET_BACKFILL_CONTEXT_DAYS), end);
  var span = rocToISO(start) + '…' + rocToISO(end);
  var refused = fetched.unanswered;
  if (refused.length) {
    var why = 'MOA did not answer ' + refused.length + ' roots (' +
      refused.slice(0, 3).join('、') + (refused.length > 3 ? '…' : '') + ')';
    // The same few crops refused every time, the probe answering throughout,
    // is MOA refusing those crops: write the window without them, on record.
    // Anything else — the probe refused, or a batch-sized hole — is a
    // throttle or an outage, and fails the window until it clears.
    var few = refused.length <= SHEET_BACKFILL_MAX_REFUSED && refused.indexOf(PROBE_ROOT) === -1;
    if (!few || !settledAnswer(job, 'refused ' + refused.join('、'))) throw new Error(why);
    job.partial = recent(job.partial, span + ' without ' + refused.join('、'));
  }
  var built = backfillDays(fetched.rows, start, end, fetched.dropped);
  if (built === null) {
    // MOA answered — a throttle is an empty body, and fails above as
    // unanswered — yet has no probe rows for the window, where even a closed
    // market gets `休市` rows. Retried first; said the same way every time,
    // it is a hole in MOA's own data, and stepping past it on record is the
    // only way the rest of the reach gets done.
    if (!settledAnswer(job, 'empty')) throw new Error('no ' + PROBE_ROOT + ' rows for ' + start + '–' + end);
    job.gaps = recent(job.gaps, span);
    job.windows += 1;
    job.failures = 0;
    job.last_error = null;
    moveBackfillCursor(job, shiftROC(start, -1));
    return;
  }

  var written = writeArchivedDays(sheetId, built.days, job.id);
  job.windows += 1;
  job.days_written += written.days;
  job.days_skipped += written.skipped;
  job.days_rejected = (job.days_rejected || 0) + built.rejected.length;
  for (var r = 0; r < built.rejected.length; r++) job.rejected = recent(job.rejected, built.rejected[r]);
  job.rows_written += written.rows;
  job.failures = 0;
  job.last_error = null;
  moveBackfillCursor(job, built.deferred || shiftROC(start, -1));
}

/**
 * Whether MOA has now answered the window at the cursor this same way often
 * enough to act on. Counted per answer, not per failure: a link killed by the
 * limit, or a Sheet that would not open, says nothing about what MOA has for
 * these days.
 *
 * Until it has, the window is retried — and the retry is refunded from the
 * failure budget, which is for links that failed, so an unrelated failure
 * cannot stop the job one answer short of settling. The refund is capped per
 * window: answers that keep changing are charged again, or they could retry
 * for ever.
 */
function settledAnswer(job, kind) {
  var v = job.verdict;
  if (!v || v.cursor !== job.cursor) v = job.verdict = { cursor: job.cursor, kind: kind, count: 0, tries: 0 };
  if (v.kind !== kind) {
    v.kind = kind;
    v.count = 0;
  }
  v.count += 1;
  v.tries += 1;
  if (v.count >= SHEET_BACKFILL_MAX_FAILURES) return true;
  if (v.tries < 2 * SHEET_BACKFILL_MAX_FAILURES) job.failures = Math.max(0, (job.failures || 0) - 1);
  return false;
}

/** `list` with `entry` appended, keeping the last few: it lives in a property. */
function recent(list, entry) {
  return (list || []).concat([entry]).slice(-10);
}

function moveBackfillCursor(job, roc) {
  job.cursor = rocToISO(roc);
  job.verdict = null;
  if (roc < isoToROC(job.from)) job.status = 'done';
}

/**
 * The archive rows for each trading day in [rocStart, rocEnd], built from one
 * range crawl exactly as the live path builds a day — `boardCards` against the
 * previous trading day, then the whole plausibility guard, then
 * `historyRowsFor`. Rows dated before `rocStart` are only ever context. Pure.
 *
 * The guard is applied the way the live path applies it, day after day: each
 * day is judged against the last day it let through, which is what the live
 * path would have had stored. A day it refuses is not written — the board
 * would not have shown it — and the day after is judged against the one
 * before. Its item rules mark suspects, which `historyRowsFor` leaves out.
 *
 * The oldest day in the window has no previous trading day in hand when a
 * closure longer than the context days sits right before it. It is not
 * written unjudged: it is returned as `deferred`, and the caller ends the next
 * window on it, where the window's own days lie behind it. The newest day is
 * never deferred — the next window would end on it again — and is judged
 * against nothing, as the live path does after a closure past its lookback.
 *
 * `dropped` maps a root to the days it truncated on alone (`fetchCompleteRows`)
 * and so is missing from. For the probe root such a day is still a trading
 * day — more than a thousand rows of 甘藍 is trading by any measure — and
 * leaving it out of the calendar would judge the next day against the one
 * before. For any root, the day after has nothing to judge that crop against,
 * so the crop is withheld from it rather than written unjudged.
 * @returns {{days: Array<{date: string, rows: Array}>, deferred: ?string,
 *   rejected: string[]}|null} null when the probe root has no rows at all
 *   dated inside the window — not even `休市` ones.
 */
function backfillDays(rowsByRoot, rocStart, rocEnd, dropped) {
  dropped = dropped || {};
  var probeRows = rowsByRoot[PROBE_ROOT] || [];
  var probeDropped = dropped[PROBE_ROOT] || [];
  var inRange = function (day) { return day >= rocStart && day <= rocEnd; };
  // The window's OWN days: probe rows only in the context days before it
  // would otherwise pass for nine days of nothing, and be stepped past.
  var seen = probeDropped.some(inRange) || probeRows.some(function (r) { return inRange(r.TransDate); });
  if (!seen) return null;
  var trading = tradingDates(probeRows);
  probeDropped.forEach(function (day) {
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
  var droppedOn = {};
  Object.keys(dropped).forEach(function (root) {
    dropped[root].forEach(function (day) {
      (droppedOn[day] = droppedOn[day] || {})[root] = true;
    });
  });

  var days = [];
  var rejected = [];
  var deferred = null;
  var accepted = null; // the last day the guard let through
  for (var t = 0; t < trading.length && trading[t] <= rocEnd; t++) {
    var day = trading[t];
    var prev = t > 0 ? trading[t - 1] : null;
    var inWindow = day >= rocStart;
    if (inWindow && !prev && day !== rocEnd) {
      // Judged all the same — it is the day the next one is judged against —
      // but written by the next window, where it has a day behind it.
      deferred = day;
      inWindow = false;
    }
    var board = {
      date: rocToISO(day),
      roc_date: day,
      items: boardCards(byDay[day] || {}, (prev && byDay[prev]) || {})
    };
    var verdict = validateBoard(board, accepted);
    if (!verdict.ok) {
      if (inWindow) rejected.push(board.date + ': ' + verdict.reasons.join('; '));
      continue;
    }
    markSuspects(board, verdict.suspects);
    var unjudged = (prev && droppedOn[prev]) || {};
    for (var i = 0; i < board.items.length; i++) {
      if (unjudged[board.items[i].official_name]) board.items[i].suspect = true;
    }
    accepted = board;
    if (!inWindow) continue;
    var rows = historyRowsFor(board);
    if (rows.length) days.push({ date: board.date, rows: rows });
  }
  return { days: days, deferred: deferred, rejected: rejected };
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

  // Forgotten BEFORE the append, not updated after it: an append that fails
  // part-way — one tab written, the next not, or the link killed in between —
  // must leave the next link reading the Sheet, not a set that says those
  // days are still missing.
  for (var k = 0; k < blocks.length; k++) forgetPresent(cache, jobId, blocks[k].year);
  var ran = false;
  var append = function () {
    ran = true;
    for (var b = 0; b < blocks.length; b++) {
      var sheet = yearSheet(spreadsheet, blocks[b].year);
      var from = appendRow(sheet);
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

function forgetPresent(cache, jobId, year) {
  if (!jobId) return;
  try {
    cache.remove(SHEET_PRESENT_CACHE_PREFIX + jobId + '_' + year);
  } catch (err) {
    // Then a stale set could outlive a failed append: fail the window rather
    // than risk writing its days twice.
    Logger.log('forgetPresent: could not forget ' + year + ': ' + err);
    throw err;
  }
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
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get(SHEET_SUMMARY_CACHE_KEY);
    if (hit) {
      var cached = JSON.parse(hit);
      if (cached.sheet === sheetId) return cached.summary;
    }
  } catch (err) {
    Logger.log('archiveSummary: cache unreadable: ' + err);
  }
  var summary = countArchive(sheetId);
  if (!summary.error) {
    try {
      cache.put(SHEET_SUMMARY_CACHE_KEY, JSON.stringify({ sheet: sheetId, summary: summary }), SHEET_SUMMARY_CACHE_TTL);
    } catch (err) {
      Logger.log('archiveSummary: not cached: ' + err);
    }
  }
  return summary;
}

function countArchive(sheetId) {
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
      last_date: sorted[sorted.length - 1] || null,
      as_of: new Date().toISOString() // cached for ten minutes: polling is free
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
    days_rejected: job.days_rejected || 0,
    gaps: (job.gaps || []).length,
    partial: (job.partial || []).length,
    rows_written: job.rows_written,
    failures: job.failures,
    updated_at: job.updated_at
  };
}
