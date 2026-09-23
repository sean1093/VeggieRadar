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
