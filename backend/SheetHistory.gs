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
      if (existing.scattered) {
        // Recorded as written, so this is not retried every refresh: the day
        // is in the Sheet, and the correction is what is given up.
        Logger.log('archiveDay: ' + board.date + ' is not one block (tab sorted by another column?); not replaced');
        props.setProperty(SHEET_LAST_WRITE_PROP, board.date + ' ' + board.generated_at);
        return 'scattered';
      }
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
  // Frozen, so sorting the tab in the Sheets UI — which the README says is
  // safe — sorts the data and leaves the header on row 1, where every reader
  // here expects it.
  sheet.setFrozenRows(1);
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
 * One date's block: where it starts, how long it is, and what is in it. A
 * day's rows are contiguous because each writer appends a day as one block —
 * the live path and the backfill alike, though not in date order — and
 * sorting the tab by date keeps them so. Sorting it by anything else does
 * not, and that is reported as `scattered` rather than guessed around.
 */
function readDay(sheet, date, zone) {
  var runs = findRuns(sheet, date, date, zone);
  if (!runs.length) return { first: 0, count: 0, rows: [] };
  var first = runs[0].first;
  var count = 0;
  for (var r = 0; r < runs.length; r++) count += runs[r].last - runs[r].first + 1;
  // Scattered: someone sorted the tab by another column. Neither reading the
  // block nor deleting it would touch only this day, so say so instead.
  if (runs.length > 1) return { first: first, count: count, rows: [], scattered: true };
  return { first: first, count: count, rows: sheet.getRange(first, 1, count, SHEET_HEADER.length).getValues() };
}

/**
 * The runs of consecutive rows whose date lies in [from, to], 1-based, found
 * by reading column A alone: a backfilled year is ~50k rows, and all eight
 * columns of it would be 400k cells read to use a few hundred. The one way
 * this archive locates a day, for the correction path and the year-ago read.
 */
function findRuns(sheet, from, to, zone) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var cells = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var runs = [];
  for (var i = 0; i < cells.length; i++) {
    var day = cellDate(cells[i][0], zone);
    // Text that sorts between two dates (one typed with a trailing space) is
    // let into a run on purpose: dropping it would split the run around it,
    // and the second read checks every row's date anyway (`scanTab`);
    // `readDay` matches one exact date, which such text never is.
    if (day < from || day > to) continue;
    var row = i + 2; // past the header
    var run = runs[runs.length - 1];
    if (run && run.last === row - 1) {
      run.last = row;
    } else {
      runs.push({ first: row, last: row });
    }
  }
  return runs;
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
  if (params.cancel && params.cancel !== '1') {
    // Strict both ways: `cancel=true` must neither cancel by accident nor be
    // read as "no cancel" and resume the job it was meant to stop.
    return backfillReply(readSheetBackfill(props), false, 'cancel 參數只接受 1');
  }
  var cancel = params.cancel === '1';
  // A cancel needs no sheet: clearing the property is a natural way to stop
  // archiving, and the job it leaves running must still be stoppable. Nor
  // does it look at anything else in the request — the start URL with
  // `&cancel=1` added must stop the job whatever its `months` says.
  if (!sheetId && !cancel) return backfillReply(readSheetBackfill(props), false, '尚未設定 HISTORY_SHEET_ID');
  if (!cancel && params.months && backfillMonths(params.months) === null) {
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
  if (resuming && job.status === 'running' && (job.failures || 0) >= SHEET_BACKFILL_MAX_FAILURES) {
    // Stalled with its failures already spent: the links that stalled it
    // were counted and never came back. Said as it is rather than queued, to
    // fail on its first step; asking again retries it, as for any failed job.
    job.status = 'failed';
    job.last_error = job.last_error || 'the last ' + job.failures + ' links did not finish';
    job.updated_at = new Date().toISOString();
    writeSheetBackfill(props, job);
    return backfillReply(job, false, '回填已失敗（' + job.last_error + '）；再送一次即重試');
  }
  if (resuming) {
    // An operator retrying a chain that gave up starts its count again. A
    // chain that merely stalled keeps it: the link that stalled it may have
    // been killed by the 6-minute limit, and a window that always is has to
    // reach `failed` rather than be resumed for ever.
    if (job.status === 'failed') job.failures = 0;
    // A job started before the reach took in the year-ago week gets it now,
    // or today's comparison would be half a window for its first week.
    var reach = backfillFrom(isoToROC(shiftISO(job.to, 1)), job.months); // `to` is the day before the board's
    if (reach < job.from) job.from = reach;
  } else {
    var board = parseStoredBoard(readDurableBoard());
    if (!board || !board.roc_date) return backfillReply(job, false, '尚無看板，無法決定回填終點');
    job = newSheetBackfill(board.roc_date, months, job, sheetId);
  }
  job.status = 'running';
  job.updated_at = new Date().toISOString();
  // Any lease a link still holds on it is revoked: that link, if it is
  // somehow still running, must not finish over the job resumed here.
  job.link_id = null;
  job.link_open = false;
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
    from: backfillFrom(boardRoc, n),
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
    holes: [], // days moved past but not written whole: coverage leaves them out
    gaps: [], // windows MOA kept answering with nothing at all
    partial: [], // windows written without a crop MOA kept refusing
    verdict: null // how MOA has answered the window at the cursor, and how often
  };
}

/**
 * How far back a job reaching `months` from `boardRoc` goes: those months, and
 * the week before them, which is the far half of the year-ago window the
 * comparison (§2) reads for the board's date — a job reaching back exactly a
 * year would leave today's comparison half a window. The one formula for a
 * new job and a resumed one.
 */
function backfillFrom(boardRoc, months) {
  return rocToISO(shiftROC(monthsBefore(boardRoc, months), -YOY_WINDOW_DAYS));
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
  if (job.holes_overflow) return mergeRanges(job.skip || [], 20); // see `addHoles`
  var ranges = (job.skip || []).slice();
  var cursorNext = shiftISO(job.cursor, 1);
  var from = cursorNext > job.from ? cursorNext : job.from;
  if (from <= job.to) ranges.push({ from: from, to: job.to });
  return mergeRanges(subtractRanges(mergeRanges(ranges, 1000), job.holes || []), 20);
}

/** `ranges` less every day in `holes`. */
function subtractRanges(ranges, holes) {
  var out = ranges;
  for (var h = 0; h < holes.length; h++) {
    var hole = holes[h];
    var next = [];
    for (var r = 0; r < out.length; r++) {
      var range = out[r];
      if (hole.to < range.from || hole.from > range.to) {
        next.push(range);
        continue;
      }
      if (hole.from > range.from) next.push({ from: range.from, to: shiftISO(hole.from, -1) });
      if (hole.to < range.to) next.push({ from: shiftISO(hole.to, 1), to: range.to });
    }
    out = next;
  }
  return out;
}

/**
 * Date ranges sorted and joined where they overlap or touch. The newest `keep`
 * are kept: the list lives in a property, and the newest are what a new job
 * meets first.
 */
function mergeRanges(ranges, keep) {
  var sorted = ranges.slice().sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; });
  var out = [];
  for (var i = 0; i < sorted.length; i++) {
    var last = out[out.length - 1];
    if (last && sorted[i].from <= shiftISO(last.to, 1)) {
      if (sorted[i].to > last.to) last.to = sorted[i].to;
    } else {
      out.push({ from: sorted[i].from, to: sorted[i].to });
    }
  }
  return out.slice(-keep);
}

/**
 * One link of the chain: one window crawled and written, then the next link
 * queued. Never throws — a trigger that throws is just a stopped chain with
 * nothing recorded about why.
 *
 * A link holds a LEASE on the job, taken under the history lock when it
 * begins (`link_id`). It appends only while it still holds it — checked under
 * the lock the append runs in — and finishes only while it still holds it, so
 * a link its own watchdog has taken over, or one a resume has revoked, can
 * neither write a window twice nor write its state over the newer one.
 * @param {Object=} e the trigger event, whose `triggerUid` is this link's own.
 */
function sheetBackfillStep(e) {
  var props;
  try {
    props = PropertiesService.getScriptProperties();
  } catch (err) {
    // Nothing to record it in. The trigger stays, spent, until the next
    // `months=` request drops it; the job reads as stalled and resumes.
    Logger.log('sheetBackfillStep: properties unavailable: ' + err);
    return null;
  }
  var begun;
  var ran = false;
  try {
    begun = withHistoryLock(function () {
      ran = true;
      return beginBackfillLink(props);
    });
  } catch (err) {
    Logger.log('sheetBackfillStep: not begun: ' + err);
    if (!ran) queueSpareLink(e);
    return null;
  }
  var job = begun.job;
  if (begun.action !== 'work') return job;
  var lease = job.link_id;
  try {
    backfillWindow(job, job.sheet, lease);
  } catch (err) {
    job.last_error = String(err && err.message || err).substring(0, 200);
    Logger.log('sheetBackfillStep failed (' + job.failures + '): ' + err);
    if (job.failures >= SHEET_BACKFILL_MAX_FAILURES) job.status = 'failed';
  } finally {
    finishBackfillStep(props, job, lease);
  }
  return job;
}

/**
 * The lock was busy: try again in a minute. A spare link is harmless —
 * whichever begins second finds the other in flight and leaves. This link's
 * own trigger is spent, so it is deleted by its id rather than counted, and
 * the spare is capped against the others, so a lock held busy for a while can
 * neither pile triggers up toward the project's limit of 20 nor, counting
 * spent ones as pending, stop queueing altogether.
 */
function queueSpareLink(e) {
  try {
    var uid = e && e.triggerUid;
    var triggers = ScriptApp.getProjectTriggers();
    var pending = 0;
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() !== SHEET_BACKFILL_FN) continue;
      if (uid && triggers[i].getUniqueId() === uid) {
        ScriptApp.deleteTrigger(triggers[i]);
        continue;
      }
      pending++;
    }
    if (pending < (uid ? 2 : 3)) ScriptApp.newTrigger(SHEET_BACKFILL_FN).timeBased().after(60 * 1000).create();
  } catch (err) {
    Logger.log('sheetBackfillStep: not requeued: ' + err);
  }
}

/**
 * The start of a link, under the lock: whether it runs — and if it does, the
 * lease and the job marked as having a link in flight. A link with nothing to
 * do tidies up here, still under the lock.
 * @returns {{action: string, job: Object}} `work`, or `done` for anything else.
 */
function beginBackfillLink(props) {
  var job = readSheetBackfill(props);
  if (job && job.status === 'running' && linkInFlight(job)) {
    // A watchdog that fired beside a link that is alive after all. The
    // triggers, and the job, are that link's.
    Logger.log('sheetBackfillStep: another link of this job is running');
    return { action: 'done', job: job };
  }
  var tidy = !job || job.status !== 'running' || cancelRequested(props, job);
  if (!tidy && props.getProperty(HISTORY_SHEET_ID_PROP) !== job.sheet) {
    // Pointed elsewhere, or cleared, mid-job. Its cursor, its coverage and its
    // cached dates are all about the spreadsheet it started on; carrying on
    // into another would leave that one with holes the job calls covered.
    job.status = 'failed';
    job.last_error = 'HISTORY_SHEET_ID changed since this job started; start a new one';
    tidy = true;
  }
  if (!tidy && (job.failures || 0) >= SHEET_BACKFILL_MAX_FAILURES) {
    // The previous links were counted and never reported back: killed by the
    // execution limit, most likely, which no `catch` survives.
    job.status = 'failed';
    job.last_error = job.last_error || 'the last ' + job.failures + ' links did not finish';
    tidy = true;
  }
  if (tidy) {
    finishLocked(props, job, job ? job.link_id : null);
    return { action: 'done', job: job };
  }
  // Counted BEFORE the work, and cleared by a window that succeeds: a link
  // the 6-minute limit kills never reaches its `catch` or its `finally`.
  job.failures = (job.failures || 0) + 1;
  // Also the heartbeat: a link in flight must not look like a stalled chain
  // to a `months=` request, nor be taken over before it could have finished.
  job.updated_at = new Date().toISOString();
  job.link_started_at = job.updated_at;
  job.link_open = true;
  job.link_id = job.updated_at + '-' + Math.random().toString(36).substring(2, 10);
  writeSheetBackfill(props, job);
  armBackfillWatchdog();
  return { action: 'work', job: job };
}

/**
 * Records the link and queues the next, under the lock — so a resume cannot
 * slip in between this link's "failed" and its dropping the triggers, and
 * delete the link the resume just queued. Busy, it leaves the watchdog to
 * retry past the limit.
 */
function finishBackfillStep(props, job, lease) {
  try {
    withHistoryLock(function () { finishLocked(props, job, lease); });
  } catch (err) {
    Logger.log('finishBackfillStep: not finished; leaving the watchdog: ' + err);
  }
}

function finishLocked(props, job, lease) {
  var stored;
  try {
    stored = readSheetBackfill(props);
  } catch (err) {
    // Unknowable whose job is stored, so nothing is safe to drop or queue.
    Logger.log('finishBackfillStep: job unreadable; leaving the triggers: ' + err);
    return;
  }
  if (!stored) {
    dropTriggersQuietly(); // no job: nothing for any link to do
    return;
  }
  // Only the holder of the lease speaks for the job. Anyone else — a link
  // whose watchdog took over, a link a resume revoked, a job replaced — has
  // been superseded, and what is stored, triggers included, is someone else's.
  if (!job || stored.id !== job.id || (stored.link_id || null) !== (lease || null)) {
    Logger.log('finishBackfillStep: superseded; leaving the job to its current link');
    return;
  }
  if (cancelRequested(props, job)) {
    // Keep the cancel — even over a window that just finished the job — and
    // drop this link's progress with it: the operator was told it stopped.
    // What the link wrote is in the Sheet all the same, and skipped next time.
    job = stored;
    job.status = 'cancelled';
  }
  job.updated_at = new Date().toISOString();
  job.link_open = false;
  try {
    writeSheetBackfill(props, job);
  } catch (err) {
    // The stored job still reads as a link in flight, so a next link queued
    // now would take itself for a duplicate and stop. Leave the watchdog
    // instead: by the time it fires that link is past the limit, and it
    // retries the window, whose days are skipped if they were written.
    Logger.log('finishBackfillStep: job not recorded; leaving the watchdog: ' + err);
    return;
  }
  dropTriggersQuietly();
  if (job.status !== 'running') return;
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

function dropTriggersQuietly() {
  try {
    dropTriggers(SHEET_BACKFILL_FN);
  } catch (err) {
    Logger.log('finishBackfillStep: trigger not dropped: ' + err);
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
function backfillWindow(job, sheetId, lease) {
  if (!sheetId) throw new Error('HISTORY_SHEET_ID is not set');
  var from = isoToROC(job.from);
  var end = isoToROC(job.cursor);
  var skips = (job.skip || []).map(function (r) { return { from: isoToROC(r.from), to: isoToROC(r.to) }; });

  for (var k = 0; k < skips.length; k++) {
    if (end >= skips[k].from && end <= skips[k].to) {
      // Written by a job before this one: step over it without a crawl.
      completeWindow(job, shiftROC(skips[k].from, -1), false);
      return;
    }
  }
  // The span fetched is always the full request, whatever the written window
  // is clamped to below: the days before the window are context — the
  // previous trading day, and the rest of the reference a day is judged
  // against — and clamping them too would leave the first day after a long
  // closure with nothing behind it, window after window.
  var fetchFrom = shiftROC(end, -(BACKFILL_WINDOW_DAYS - 1));
  var start = shiftROC(end, -(BACKFILL_WINDOW_DAYS - SHEET_BACKFILL_CONTEXT_DAYS - 1));
  if (start < from) start = from;
  for (var m = 0; m < skips.length; m++) {
    if (end > skips[m].to && start <= skips[m].to) start = shiftROC(skips[m].to, 1);
  }

  var fetched = fetchCompleteRows(boardRoots(), fetchFrom, end);
  var span = rocToISO(start) + '…' + rocToISO(end);
  // Sorted, so the same set of refused crops is recognised as the same answer
  // however each came to be unanswered.
  var refused = fetched.unanswered.slice().sort();
  // The probe named first when it is among them: that is the one that says
  // the window cannot be judged at all.
  var named = refused.indexOf(PROBE_ROOT) === -1 ? refused
    : [PROBE_ROOT].concat(refused.filter(function (r) { return r !== PROBE_ROOT; }));
  var why = 'MOA did not answer ' + refused.length + ' roots (' +
    named.slice(0, 3).join('、') + (refused.length > 3 ? '…' : '') + ')';
  // The same few crops refused every time, the probe answering throughout,
  // is MOA refusing those crops. Anything else — the probe refused, or a
  // batch-sized hole — is a throttle or an outage, and fails the window
  // until it clears.
  if (refused.length > SHEET_BACKFILL_MAX_REFUSED || refused.indexOf(PROBE_ROOT) !== -1) throw new Error(why);

  var built = backfillDays(fetched.rows, start, end, fetched.dropped);
  // MOA answered — a throttle is an empty body, and fails above as unanswered
  // — yet has no probe rows for the window, where even a closed market gets
  // `休市` rows: a hole in MOA's own data, once it has said so every time.
  var empty = built === null;
  if (refused.length || empty) {
    // ONE answer for the window, both halves of it: judged separately, a
    // window with both would reset each count on the other and never settle.
    var answer = [refused.length ? 'refused ' + refused.join('、') : '', empty ? 'empty' : '']
      .filter(function (part) { return part; }).join(' + ');
    if (!settledAnswer(job, answer)) {
      throw new Error(empty ? 'no ' + PROBE_ROOT + ' rows for ' + start + '–' + end : why);
    }
  }
  if (empty) {
    job.gaps = recent(job.gaps, span);
    job.holes = addHoles(job, [{ from: rocToISO(start), to: rocToISO(end) }]);
    completeWindow(job, shiftROC(start, -1), true);
    return;
  }

  var written = writeArchivedDays(sheetId, built.days, job.id, lease);
  job.days_written += written.days;
  job.days_skipped += written.skipped;
  job.days_rejected = (job.days_rejected || 0) + built.rejected.length;
  var holes = [];
  for (var r = 0; r < built.rejected.length; r++) {
    var no = built.rejected[r];
    job.rejected = recent(job.rejected, (no.date + ': ' + no.reasons.join('; ')).substring(0, 160));
    holes.push({ from: no.date, to: no.date });
  }
  if (holes.length) job.holes = addHoles(job, holes);
  // Written, so not a hole: its days are in the Sheet, and a later job would
  // skip them by date anyway. Filling in the crop means deleting those rows.
  if (refused.length) job.partial = recent(job.partial, span + ' without ' + refused.join('、'));
  // A crop left out of a day because that day truncated on its own: written
  // without it, and so on record like any other partial day.
  Object.keys(fetched.dropped).forEach(function (root) {
    fetched.dropped[root].forEach(function (day) {
      if (day >= start && day <= end) job.partial = recent(job.partial, rocToISO(day) + ' without ' + root);
    });
  });
  job.rows_written += written.rows;
  completeWindow(job, built.deferred || shiftROC(start, -1), true);
}

/**
 * A window done — written, stepped over as a gap, or skipped as covered: the
 * cursor moves past it and whatever the retries were counting is cleared.
 */
function completeWindow(job, nextRoc, crawled) {
  if (crawled) job.windows += 1;
  job.failures = 0;
  job.last_error = null;
  moveBackfillCursor(job, nextRoc);
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
  if (v.count >= SHEET_BACKFILL_SETTLE_ANSWERS) return true;
  if (v.tries < 2 * SHEET_BACKFILL_SETTLE_ANSWERS) job.failures = Math.max(0, (job.failures || 0) - 1);
  return false;
}

/**
 * Days a job moved past without writing — refused by the guard, or a gap in
 * MOA's data. Kept apart from the cursor so coverage can leave them out: a
 * later job crawls them again, and writes what MOA or the guard lets through
 * by then. The list lives in a property and is capped; past the cap the job
 * is marked as having lost track, and claims no coverage of its own at all
 * (`coveredBy`) — a later job then re-crawls its range, which costs quota,
 * where forgetting a hole would cost the days in it for good.
 */
function addHoles(job, more) {
  var merged = mergeRanges((job.holes || []).concat(more), 1000);
  if (merged.length > SHEET_BACKFILL_MAX_HOLES) job.holes_overflow = true;
  return merged.slice(-SHEET_BACKFILL_MAX_HOLES);
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
 * previous trading day, the plausibility guard, then `historyRowsFor`. Rows
 * dated before `rocStart` are only ever context. Pure.
 *
 * The guard's board-level rules compare a day with another; here that other
 * is the rest of the span fetched (`judgeDay`). A refused day is not written.
 * Its item rules mark suspects, which `historyRowsFor` leaves out.
 *
 * The oldest day in the window has no previous trading day in hand when a
 * closure longer than the context days sits right before it. It is not
 * written unjudged: it is returned as `deferred`, and the caller ends the next
 * window on it, where the window's own days lie behind it. The newest day is
 * never deferred — the next window would end on it again — and is judged
 * against what it has.
 *
 * `dropped` maps a root to the days it truncated on alone (`fetchCompleteRows`)
 * and so is missing from. For the probe root such a day is still a trading
 * day — more than a thousand rows of 甘藍 is trading by any measure — and
 * leaving it out of the calendar would judge the next day against the one
 * before. For any root, the day after has nothing to judge that crop against,
 * so the crop is withheld from it rather than written unjudged.
 * @returns {{days: Array<{date: string, rows: Array}>, deferred: ?string,
 *   rejected: Array<{date: string, reasons: string[]}>}|null} null when the
 *   probe root has no rows at all dated inside the window — not even `休市`.
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
  trading = trading.filter(function (day) { return day <= rocEnd; }).sort();
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
  var boards = trading.map(function (day, t) {
    var prev = t > 0 ? trading[t - 1] : null;
    return { date: rocToISO(day), roc_date: day, items: boardCards(byDay[day] || {}, (prev && byDay[prev]) || {}) };
  });

  var days = [];
  var rejected = [];
  var deferred = null;
  for (var t = 0; t < boards.length; t++) {
    var day = trading[t];
    if (day < rocStart) continue;
    if (t === 0 && day !== rocEnd) {
      deferred = day;
      continue;
    }
    var board = boards[t];
    var verdict = judgeDay(boards, t);
    if (!verdict.ok) {
      rejected.push({ date: board.date, reasons: verdict.reasons });
      continue;
    }
    markSuspects(board, verdict.suspects);
    var unjudged = (t > 0 && droppedOn[trading[t - 1]]) || {};
    for (var i = 0; i < board.items.length; i++) {
      if (unjudged[board.items[i].official_name]) board.items[i].suspect = true;
    }
    var rows = historyRowsFor(board);
    if (rows.length) {
      days.push({ date: board.date, rows: rows });
    } else {
      // Let through, but every item withheld: nothing is written, and the day
      // must stay a hole a later job looks at again, not pass for covered.
      rejected.push({ date: board.date, reasons: ['every item withheld as suspect or unjudged'] });
    }
  }
  return { days: days, deferred: deferred, rejected: rejected };
}

/**
 * The guard on a day in the past. The live path judges a crawl against the
 * board it stored; the past has no such anchor, and a chain of "the last day
 * let through" starts every window from a day judged against nothing, while
 * a vote of the two neighbours lets a broken stretch vouch for itself. So the
 * reference is the rest of the span: each item at its median price across the
 * other days fetched. A broken day, or a short run of them, is outvoted by the
 * days around it, and every day — the first and the newest alike — has one.
 *
 * What it cannot tell apart is a broken stretch from a real shift that lasts
 * (a typhoon week): either way the minority side of the span is refused. That
 * is the archive's rule — a missing day over a wrong one — and the refused
 * days are holes, which a later job, whose spans fall differently, judges
 * again. The live guard, judging day over day, refuses the other side.
 * Dates are left off both, since rule (d) exists to refuse a board older than
 * the one before it, and the reference has no date.
 */
function judgeDay(boards, t) {
  var prices = {};
  var others = 0;
  for (var u = 0; u < boards.length; u++) {
    if (u === t) continue;
    others++;
    for (var i = 0; i < boards[u].items.length; i++) {
      var it = boards[u].items[i];
      if (it.catty_price > 0) (prices[it.name] = prices[it.name] || []).push(it.catty_price);
    }
  }
  // The items a typical day of the span carries: on at least half of the
  // other days. Every item seen on any day would make the reference a board
  // no single day has, and rule (a)'s "60 % of the reference" a bar that a
  // normal day misses.
  var reference = Object.keys(prices).filter(function (name) {
    return prices[name].length * 2 >= others;
  }).map(function (name) {
    return { name: name, catty_price: median(prices[name]) };
  });
  return validateBoard({ items: boards[t].items }, reference.length ? { items: reference } : null);
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
function writeArchivedDays(sheetId, days, jobId, lease) {
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
    // Still this link's to write? Checked under the same lock a takeover
    // takes, so a link its watchdog has replaced — or a resume has revoked —
    // cannot append a window the new link is writing too.
    if (lease) {
      var current = readSheetBackfill(PropertiesService.getScriptProperties());
      if (!current || current.id !== jobId || current.link_id !== lease) {
        throw new Error('superseded: another link holds this job now');
      }
    }
    for (var b = 0; b < blocks.length; b++) {
      var sheet = yearSheet(spreadsheet, blocks[b].year);
      // Tabs the live archive made before the header was frozen get it
      // frozen here, so the README's "sort column A freely" holds for them.
      // Once per tab while the cache remembers, not on every append under
      // the lock the refresh waits on.
      freezeOnce(sheet, blocks[b].year, cache);
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

function freezeOnce(sheet, year, cache) {
  var key = SHEET_FROZEN_CACHE_PREFIX + year;
  try {
    if (cache.get(key)) return;
  } catch (err) {
    // Unknown: freezing again is harmless.
  }
  sheet.setFrozenRows(1);
  try {
    cache.put(key, '1', SHEET_PRESENT_CACHE_TTL);
  } catch (err) {
    Logger.log('freezeOnce: not remembered: ' + err);
  }
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
  for (var i = 0; i < cells.length; i++) {
    var day = cellDate(cells[i][0], zone);
    // Only a date is a day: not a blank cell, nor a header that a sort by
    // hand moved into the data.
    if (ISO_DAY.test(day)) present[day] = true;
  }
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
      // Rows and days from the same cells: a blank row, or a header a sort
      // by hand moved into the data, is neither.
      var cells = tabs[i].getRange(2, 1, last - 1, 1).getValues();
      for (var c = 0; c < cells.length; c++) {
        var day = cellDate(cells[c][0], zone);
        if (!ISO_DAY.test(day)) continue;
        rows++;
        dates[day] = true;
      }
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
  return parseJson(raw);
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


// --- Same weeks last year (#22 §2) ---
//
// The archive's first reader. Everything here is optional in the same way the
// archive is: no `HISTORY_SHEET_ID`, no fields; a Sheet that cannot be read,
// no fields; an item with too few days a year back, no fields for that item.
// The board never waits on it and never fails for it.

/**
 * Attaches `last_year_price` (元/台斤) and `vs_last_year_percent` to the items
 * the archive has a year-ago median for, the way `applyBaselines` attaches the
 * 28-day ones. Wholesale against wholesale: the archive holds `avg_price`.
 */
function applyYearOverYear(items, medians) {
  if (!medians) return;
  for (var i = 0; i < items.length; i++) {
    attachComparison(items[i], medians[items[i].name], 'last_year_price', 'vs_last_year_percent');
  }
}

/**
 * The medians the last read kept, for a board of `boardRoc`, or null. Cheap —
 * a property — so the build can use it; the Sheets read is `refreshYearAgo`.
 * Medians kept for another spreadsheet, or for a window too far from this
 * date, are not applied.
 */
function keptYearAgo(boardRoc) {
  try {
    var props = PropertiesService.getScriptProperties();
    var sheetId = props.getProperty(HISTORY_SHEET_ID_PROP);
    if (!sheetId || !boardRoc) return null;
    return keptItemsFor(parseYearAgo(props.getProperty(YOY_PROP)), sheetId, boardRoc);
  } catch (err) {
    Logger.log('keptYearAgo: ' + err);
    return null;
  }
}

/**
 * Reads the Sheet for this trading date's year-ago medians when what is kept
 * is not for this date and spreadsheet, or has aged past its keep (see
 * `YOY_KEEP_MS`). The last step of a refresh. Never throws; a failed read is
 * not kept, so the next refresh tries again.
 * @returns {Object|null} the medians now kept, or null when there is no
 *   archive or the read failed.
 */
function refreshYearAgo(boardRoc, startedAt) {
  try {
    var props = PropertiesService.getScriptProperties();
    var sheetId = props.getProperty(HISTORY_SHEET_ID_PROP);
    if (!sheetId || !boardRoc) return null;

    var kept = parseYearAgo(props.getProperty(YOY_PROP));
    var job = parseSheetBackfill(props.getProperty(SHEET_BACKFILL_PROP));
    var span = yearAgoWindow(boardRoc);
    if (keptStillFresh(kept, boardRoc, sheetId, job, span)) return kept.items;
    if (backfillHoldsWindow(job, sheetId, span)) {
      // A backfill still walking through the window has written only its
      // newer days, and a median of those would be published as 「去年此時」.
      // Nothing is read, and nothing kept: kept, an empty answer would
      // outlive the backfill. Every refresh asks again, which costs a
      // property; the kept medians of an earlier date stand meanwhile, and
      // `diag` says it waits (`noteReaderState`).
      return {};
    }
    if (startedAt && Date.now() - startedAt > YOY_START_BY_MS) {
      // Late in a long refresh: the execution limit would end the run without
      // the cleanup its caller does (`refreshBoardCacheOnce`'s `finally`). The
      // next refresh reads; this one keeps what is kept — and says so in
      // `diag`, or refreshes that are always this slow would leave the
      // comparison off with nothing to show why.
      Logger.log('refreshYearAgo: skipped, the refresh has run ' + Math.round((Date.now() - startedAt) / 1000) + ' s');
      noteUnread(props, YOY_SKIPPED_PROP, sheetId, 'late');
      return null;
    }
    // The board's own year is the one tab read under the history lock — late
    // in December, when the window reaches it (`yearAgoMedians`).
    var found = yearAgoMedians(SpreadsheetApp.openById(sheetId), span, rocToISO(boardRoc).substring(0, 4));
    try {
      props.setProperty(YOY_PROP, JSON.stringify({
        date: boardRoc, sheet: sheetId, at: new Date().toISOString(),
        items: found.items, scattered: found.scattered || undefined
      }));
      props.deleteProperty(YOY_SKIPPED_PROP); // read after all: nothing left undone
    } catch (err) {
      // Read again by the next refresh — and said in `diag`, or a full
      // property store would have every refresh read with nothing showing why.
      Logger.log('refreshYearAgo: not kept: ' + err);
      try {
        noteUnread(props, YOY_SKIPPED_PROP, sheetId, 'not kept');
      } catch (err2) {
        Logger.log('refreshYearAgo: not noted: ' + err2);
      }
    }
    return found.items;
  } catch (err) {
    // Not kept: the next refresh asks again, rather than the day going
    // without a comparison because one read failed — and `diag` says so.
    Logger.log('refreshYearAgo failed: ' + err);
    try {
      if (props) noteUnread(props, YOY_SKIPPED_PROP, sheetId, 'failed'); // both set above, or nothing to note
    } catch (err2) {
      Logger.log('refreshYearAgo: not noted: ' + err2);
    }
    return null;
  }
}

/**
 * Whether a running backfill has yet to write part of a reader's span: its
 * reach includes some of it, its cursor has not passed it, and that part is
 * not a range it skips as already written.
 */
function walking(job, span) {
  if (job.cursor < span.from) return false;
  var open = subtractRanges([{ from: span.from, to: job.cursor < span.to ? job.cursor : span.to }], job.skip || []);
  return open.length > 0;
}

/**
 * The ISO dates a year back, `YOY_WINDOW_DAYS` either side of `boardRoc`, and
 * the day itself — the same "a year back" the backfill reaches with, so
 * 02-29 is 02-28.
 */
function yearAgoWindow(boardRoc) {
  var iso = rocToISO(monthsBefore(boardRoc, 12));
  return { from: shiftISO(iso, -YOY_WINDOW_DAYS), to: shiftISO(iso, YOY_WINDOW_DAYS), day: iso };
}

/**
 * What a reader kept, if it may be applied to a board of `boardRoc`: read
 * from this spreadsheet, for a trading date near enough (`keptApplies`).
 */
function keptItemsFor(kept, sheetId, boardRoc) {
  if (!kept || !kept.items || kept.sheet !== sheetId) return null;
  return keptApplies(kept, boardRoc) ? kept.items : null;
}

/** Whether medians kept for one trading date may be applied to a board of another. */
function keptApplies(kept, boardRoc) {
  var apart = Math.abs(rocToDate(boardRoc).getTime() - rocToDate(kept.date).getTime()) / 86400000;
  return apart <= YOY_KEPT_MAX_DAYS;
}

/**
 * Whether what a read of `span` kept for `boardRoc` still stands. A day,
 * normally; six hours while a backfill that reaches the span runs, or after
 * the tab was found out of date order (its fix is a re-sort by hand, which
 * nothing else here would notice) — and not a moment longer once such a
 * backfill has FINISHED since the read: an answer read before a backfill must
 * not outlive it by a day. (A running one bumps its clock every link, so
 * "written since" would mean every refresh.) The rule for every reader of the
 * archive the refresh keeps a result for.
 */
function keptStillFresh(kept, boardRoc, sheetId, job, span) {
  if (!kept || kept.date !== boardRoc || kept.sheet !== sheetId) return false;
  var finishedSince = backfillReaches(job, sheetId, span) && job.status !== 'running' &&
    Date.parse(job.updated_at || '') > Date.parse(kept.at);
  if (finishedSince) return false;
  var soon = backfillActive(job, sheetId, span) || kept.scattered;
  return Date.now() - Date.parse(kept.at) < (soon ? YOY_SOON_MS : YOY_KEEP_MS);
}

/**
 * A backfill job of this spreadsheet whose range overlaps `span`: the only
 * kind that can change what a read of it finds. One filling the last month
 * cannot reach a year back, nor one filling 2023 the last month.
 */
function backfillReaches(job, sheetId, span) {
  return !!job && job.sheet === sheetId && job.from <= span.to && job.to >= span.from;
}

/** …and running: its links still writing, not stalled. */
function backfillActive(job, sheetId, span) {
  return backfillReaches(job, sheetId, span) && job.status === 'running' && !backfillStalled(job);
}

/**
 * …and not yet past the span, so a read now would find only its newer days.
 * What holds the read back in `refreshYearAgo`, and what `diag` reports as
 * waiting.
 */
function backfillHoldsWindow(job, sheetId, span) {
  return backfillActive(job, sheetId, span) && walking(job, span);
}

function parseYearAgo(raw) {
  var kept = parseJson(raw);
  return kept && kept.items ? kept : null;
}

/** A property's JSON, or null when absent or unreadable. */
function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    Logger.log('parseJson: unreadable property: ' + err);
    return null;
  }
}

/**
 * The medians themselves: the blend rows (variety empty) of the archived days
 * in the window, per item — walked by `scanSpan`, which says which tab is read
 * under the lock and which tabs are reported `scattered`. Suspect days never
 * reached the archive, so there is nothing to filter here.
 *
 * An item needs `YOY_MIN_SIDE_DAYS` archived days on EACH side of the day a
 * year back, and its median is taken over the SAME number from each side —
 * the nearest ones — plus the day itself if archived (`yearAgoFromPrices`).
 * Only board items are kept, rounded to the hundredth: the property holding
 * them has a size limit, and `diag` counts what the board can apply.
 */
function yearAgoMedians(spreadsheet, span, liveYear) {
  var prices = {};
  var scattered = scanSpan(spreadsheet, span, liveYear, function (cells, date) {
    if (cells[3] !== '' && cells[3] !== null) return; // a variety row
    var price = Number(cells[4]);
    if (!(price > 0)) return;
    // One value per day: a day archived twice must not weigh twice. The row
    // written last wins, since a later write is the likelier correction.
    var name = String(cells[1]);
    (prices[name] = prices[name] || {})[date] = price;
  });
  if (scattered) return { items: {}, scattered: true };
  return { items: yearAgoFromPrices(prices, span) };
}

/**
 * Every archived row dated in `span`, handed to `onRow(cells, isoDate)`, from
 * each year tab it touches. The live year's tab is read under the history
 * lock, and only it: the live path deletes and rewrites its day there, which
 * would move rows between the two reads; older tabs are only ever appended
 * to. The one way the archive's readers walk it.
 * @returns {boolean} true when a tab is out of date order, and was not read.
 */
function scanSpan(spreadsheet, span, liveYear, onRow) {
  var zone = spreadsheet.getSpreadsheetTimeZone();
  var first = span.from.substring(0, 4);
  var last = span.to.substring(0, 4);
  var years = first === last ? [first] : [first, last];
  for (var y = 0; y < years.length; y++) {
    var sheet = spreadsheet.getSheetByName(years[y]);
    if (!sheet) continue;
    var read = scanTab.bind(null, sheet, span, zone, onRow);
    if (years[y] === liveYear ? withHistoryLock(read, READER_LOCK_WAIT_MS) : read()) {
      Logger.log('scanSpan: ' + years[y] + ' is not in date order; not read');
      return true;
    }
  }
  return false;
}

/**
 * One year tab's rows in the span, handed to `onRow`.
 * @returns {boolean} true when the tab is out of date order and was not read.
 */
function scanTab(sheet, span, zone, onRow) {
  var runs = findRuns(sheet, span.from, span.to, zone);
  // A tab sorted by another column scatters the span into a run per item and
  // day — hundreds. A long span in order may have more runs than a week (live
  // days after a backfill's older windows, holes filled later): one a day
  // is still far short of scattered.
  var days = (Date.parse(span.to) - Date.parse(span.from)) / 86400000 + 1;
  if (runs.length > Math.max(YOY_MAX_RUNS, days)) return true;
  // Runs close together are read in one call — the dates are checked row by
  // row anyway — so a week split by a few live days is one round trip.
  if (runs.length > 1) {
    var wanted = 0;
    for (var q = 0; q < runs.length; q++) wanted += runs[q].last - runs[q].first + 1;
    var spanRows = runs[runs.length - 1].last - runs[0].first + 1;
    if (spanRows <= wanted * 2 + YOY_MERGE_SLACK_ROWS) runs = [{ first: runs[0].first, last: runs[runs.length - 1].last }];
  }
  for (var r = 0; r < runs.length; r++) {
    var values = sheet.getRange(runs[r].first, 1, runs[r].last - runs[r].first + 1, SHEET_HEADER.length).getValues();
    for (var v = 0; v < values.length; v++) {
      var cells8 = values[v];
      // Checked again, not trusted from the first read: a sort by hand
      // between the two would put other days on these rows.
      var date = cellDate(cells8[0], zone);
      if (!ISO_DAY.test(date) || date < span.from || date > span.to) continue;
      onRow(cells8, date);
    }
  }
  return false;
}

/**
 * Each board item's median over the SAME number of archived days from each
 * side of the day a year back — the nearest — and the day itself if archived,
 * with at least `YOY_MIN_SIDE_DAYS` a side.
 */
function yearAgoFromPrices(prices, span) {
  var known = {};
  for (var b = 0; b < BOARD_ITEMS.length; b++) known[BOARD_ITEMS[b].name] = true;
  var out = {};
  Object.keys(prices).forEach(function (name) {
    if (!known[name]) return;
    var dates = Object.keys(prices[name]).sort();
    var before = dates.filter(function (d) { return d < span.day; }).reverse(); // nearest first
    var after = dates.filter(function (d) { return d > span.day; });
    var perSide = Math.min(before.length, after.length);
    if (perSide < YOY_MIN_SIDE_DAYS) return;
    var sample = before.slice(0, perSide).concat(after.slice(0, perSide));
    if (prices[name][span.day] !== undefined) sample.push(span.day);
    // To the hundredth, not the tenth: the percentage is measured against the
    // median, and only the published price is rounded to a tenth.
    out[name] = Math.round(median(sample.map(function (d) { return prices[name][d]; })) * 100) / 100;
  });
  return out;
}

/**
 * The kept year-ago reference as `diag` publishes it: when, and how many.
 * Null when it is not for the spreadsheet configured now, which the build
 * would not apply either (`keptYearAgo`).
 */
function publicYearAgo(raw, sheetId, skippedAt, boardRoc, jobRaw) {
  if (!sheetId) return null;
  var kept = parseYearAgo(raw);
  var out = kept && kept.sheet === sheetId
    ? { date: kept.date, at: kept.at, items: Object.keys(kept.items).length } : null;
  if (out) {
    // Whether the board is being compared with these at all: kept medians too
    // far from its date are not applied (`keptYearAgo`).
    out.applied = !!boardRoc && keptApplies(kept, boardRoc);
    // The tab was sorted by another column, and the week could not be found.
    if (kept.scattered) out.scattered = true;
  }
  var job = parseSheetBackfill(jobRaw);
  var span = boardRoc ? yearAgoWindow(boardRoc) : null;
  out = noteReaderState(out, { date: null, at: null, items: 0, applied: false }, sheetId, span, job, skippedAt);
  // The last backfill finished short of today's year-ago window — started
  // before its reach took in the week before a year back. Asking again for
  // the same months adds only what is missing.
  if (span && job && job.sheet === sheetId && job.status === 'done' && job.from > span.from) {
    out = out || { date: null, at: null, items: 0, applied: false };
    out.backfill_short = true;
  }
  return out;
}

/**
 * What a reader's `diag` entry adds about reads the refresh did not make:
 * held back while a backfill writes the span (without this, a long backfill
 * would leave the comparison off with nothing saying why), and a read left
 * undone (`noteUnread`) for this spreadsheet and not since made good —
 * refreshes that are always too slow show here, not as a silence. `blank` is
 * the entry when nothing is kept.
 */
function noteReaderState(out, blank, sheetId, span, job, skippedRaw) {
  if (span && backfillHoldsWindow(job, sheetId, span)) {
    out = out || blank;
    out.waiting_for_backfill = true;
  }
  // Shown next to a wait too: what failed, was not kept or ran late will
  // likely go the same way once the backfill has passed.
  var skipped = parseJson(skippedRaw);
  if (skipped && skipped.sheet === sheetId && (!out || !out.at || skipped.at > out.at)) {
    out = out || blank;
    out.skipped_at = skipped.at;
    out.skipped = skipped.why || 'late';
  }
  return out;
}


// --- Per-variety baselines (#22 §3) ---
//
// The drawer decomposes a blended price into its varieties, and until now
// could say what each costs today but not whether that is cheap FOR THAT
// VARIETY: the 28-day baseline is the blend's, and 綠竹筍 at twice 麻竹筍 is
// not "expensive". The archive keeps each variety's own row a day, so each can
// have its own median — by the same rule as the item's, and read the same way
// as the year-ago medians: last in the refresh, kept per trading date, applied
// by the next build.

/**
 * Attaches `vs_baseline_percent` to each variety with a median kept for it:
 * today's variety price against that variety's own 28-day median. Wholesale
 * against wholesale; the percentage only — the drawer's row has no room for a
 * second price, and the payload no need of one.
 */
function applyVarietyBaselines(items, medians) {
  if (!medians) return;
  for (var i = 0; i < items.length; i++) {
    var bases = medians[items[i].name];
    var varieties = items[i].varieties;
    if (!bases || !varieties) continue;
    for (var v = 0; v < varieties.length; v++) {
      var base = bases[varieties[v].name];
      if (!(base > 0)) continue;
      // In 元/公斤, and from exactly the value the archive holds for today's
      // row (`historyRowsFor`): comparing the rounded 元/台斤 with an unrounded
      // median would show a variety that has not moved as 「低 1%」.
      varieties[v].vs_baseline_percent = percentAgainst(round1(varieties[v].catty_price / CATTY_PER_KG), base);
    }
  }
}

/** The kept variety medians, for a board of `boardRoc`, or null. Cheap: properties. */
function keptVarietyBaselines(boardRoc) {
  try {
    var sheetId = PropertiesService.getScriptProperties().getProperty(HISTORY_SHEET_ID_PROP);
    if (!sheetId || !boardRoc) return null;
    return keptItemsFor(parseJson(readChunkedProp(VARIETY_BASE_PREFIX, VARIETY_BASE_COUNT)), sheetId, boardRoc);
  } catch (err) {
    Logger.log('keptVarietyBaselines: ' + err);
    return null;
  }
}

/**
 * The span a variety's baseline is read from: the horizon before the board's
 * date, the day itself left out — a price must not vouch for itself, as
 * `applyBaselines` has it. Counted back from the board's trading date, where
 * the rolling history is pruned by the clock (`rocDateDaysAgo`): the two agree
 * on a trading day, and over a closure this one keeps its 45 days.
 */
function varietySpan(boardRoc) {
  return {
    from: rocToISO(shiftROC(boardRoc, -BASELINE_HORIZON_DAYS)),
    to: rocToISO(shiftROC(boardRoc, -1))
  };
}

/**
 * Reads the Sheet for this trading date's variety medians when what is kept no
 * longer stands (`keptStillFresh`). The refresh's last step, after the
 * year-ago read; never throws, and a failed read is not kept.
 * @returns {Object|null} the medians now kept (item → variety → 元/公斤).
 */
function refreshVarietyBaselines(boardRoc, startedAt) {
  try {
    var props = PropertiesService.getScriptProperties();
    var sheetId = props.getProperty(HISTORY_SHEET_ID_PROP);
    if (!sheetId || !boardRoc) return null;
    var kept = parseJson(readChunkedProp(VARIETY_BASE_PREFIX, VARIETY_BASE_COUNT));
    var job = parseSheetBackfill(props.getProperty(SHEET_BACKFILL_PROP));
    var span = varietySpan(boardRoc);
    if (kept && kept.items && keptStillFresh(kept, boardRoc, sheetId, job, span)) return kept.items;
    if (backfillHoldsWindow(job, sheetId, span)) {
      // As for the year-ago read: a backfill walking newest-first through the
      // span has written only its later days, and 28 days' median would be
      // taken over a fortnight. Not read, not kept; the medians of an earlier
      // date stand meanwhile, and `diag` says it waits.
      return null;
    }
    if (startedAt && Date.now() - startedAt > YOY_START_BY_MS) {
      // As for the year-ago read: the execution limit would end the run before
      // its caller's cleanup. Said in `diag`, and read by the next refresh.
      Logger.log('refreshVarietyBaselines: skipped, the refresh has run ' + Math.round((Date.now() - startedAt) / 1000) + ' s');
      noteUnread(props, VARIETY_BASE_SKIPPED_PROP, sheetId, 'late');
      return null;
    }
    var found = varietyMedians(SpreadsheetApp.openById(sheetId), span, rocToISO(boardRoc).substring(0, 4));
    var stored = writeChunkedProp(VARIETY_BASE_PREFIX, VARIETY_BASE_COUNT, JSON.stringify({
      date: boardRoc, sheet: sheetId, at: new Date().toISOString(),
      items: found.items, scattered: found.scattered || undefined
    }));
    if (!stored) {
      // Read, and not kept — a full property store, most likely. Said in
      // `diag`, or every refresh would read again with nothing showing why.
      noteUnread(props, VARIETY_BASE_SKIPPED_PROP, sheetId, 'not kept');
      return found.items;
    }
    props.deleteProperty(VARIETY_BASE_SKIPPED_PROP);
    return found.items;
  } catch (err) {
    // The lock busy past its short wait, the Sheet unreachable: not kept, and
    // read again by the next refresh — and said in `diag` meanwhile.
    Logger.log('refreshVarietyBaselines failed: ' + err);
    try {
      if (props) noteUnread(props, VARIETY_BASE_SKIPPED_PROP, sheetId, 'failed');
    } catch (err2) {
      Logger.log('refreshVarietyBaselines: not noted: ' + err2);
    }
    return null;
  }
}

/**
 * Records that a read of the archive was left undone, when and why — `late`
 * (the refresh had run too long), `failed` or `not kept` — for `diag`.
 */
function noteUnread(props, key, sheetId, why) {
  if (!sheetId) return;
  props.setProperty(key, JSON.stringify({ at: new Date().toISOString(), sheet: sheetId, why: why }));
}

/**
 * Each board item's varieties' medians over their most recent
 * `BASELINE_WINDOW` archived days in the span, with `BASELINE_MIN_DAYS` at
 * least — the item baseline's rule, variety by variety. One value per day.
 */
function varietyMedians(spreadsheet, span, liveYear) {
  var prices = {}; // item → variety → date → 元/公斤
  var scattered = scanSpan(spreadsheet, span, liveYear, function (cells, date) {
    var variety = cells[3];
    if (variety === '' || variety === null) return; // the blend row
    var price = Number(cells[4]);
    if (!(price > 0)) return;
    var item = String(cells[1]);
    var byVariety = (prices[item] = prices[item] || {});
    (byVariety[variety] = byVariety[variety] || {})[date] = price;
  });
  if (scattered) return { items: {}, scattered: true };

  var known = {};
  for (var b = 0; b < BOARD_ITEMS.length; b++) known[BOARD_ITEMS[b].name] = true;
  var out = {};
  Object.keys(prices).forEach(function (item) {
    if (!known[item]) return;
    Object.keys(prices[item]).forEach(function (variety) {
      var byDate = prices[item][variety];
      var recent = Object.keys(byDate).sort().slice(-BASELINE_WINDOW);
      if (recent.length < BASELINE_MIN_DAYS) return;
      var base = median(recent.map(function (d) { return byDate[d]; }));
      (out[item] = out[item] || {})[variety] = Math.round(base * 100) / 100;
    });
  });
  return { items: out };
}

/**
 * The kept variety medians as `diag` publishes them: when, and how many —
 * from the property map `diag` already read.
 */
function publicVarietyBaselines(props, boardRoc) {
  var sheetId = props[HISTORY_SHEET_ID_PROP];
  if (!sheetId) return null;
  var kept = parseJson(chunkedFrom(props, VARIETY_BASE_PREFIX, VARIETY_BASE_COUNT));
  var out = null;
  if (kept && kept.items && kept.sheet === sheetId) {
    var varieties = 0;
    Object.keys(kept.items).forEach(function (item) { varieties += Object.keys(kept.items[item]).length; });
    out = {
      date: kept.date,
      at: kept.at,
      items: Object.keys(kept.items).length,
      varieties: varieties,
      applied: !!boardRoc && keptApplies(kept, boardRoc)
    };
    if (kept.scattered) out.scattered = true;
  }
  return noteReaderState(out, { date: null, at: null, items: 0, varieties: 0, applied: false }, sheetId,
    boardRoc ? varietySpan(boardRoc) : null, parseSheetBackfill(props[SHEET_BACKFILL_PROP]), props[VARIETY_BASE_SKIPPED_PROP]);
}
