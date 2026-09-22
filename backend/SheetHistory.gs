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

  // Was this trading day already archived, and has anything changed since?
  // MOA completes a day's closing prices during the evening, so the same date
  // crawled hours later is a correction worth keeping — and the same date
  // crawled again half an hour later is the same day twice.
  //
  // The correction is capped rather than open-ended: the board keeps a trading
  // date until the next one publishes, so across a weekend or a holiday this
  // would otherwise re-replace the same unchanged day every few hours for as
  // long as the break lasts.
  var last = parseSheetWrite(written);
  var replacing = false;
  if (last && last.date === board.date) {
    var moved = Date.parse(board.generated_at || '') - Date.parse(last.generated_at || '');
    if (!(moved > SHEET_CORRECTION_MS)) return 'already written';
    if (last.corrections >= SHEET_MAX_CORRECTIONS) return 'already corrected';
    replacing = true;
  }

  // Built before anything is deleted: an all-flagged board contributes no
  // rows, and dropping the day for it would leave the archive emptier than
  // the crawl was.
  var rows = historyRowsFor(board);
  if (!rows.length) return 'nothing to write';

  try {
    var sheet = yearSheet(SpreadsheetApp.openById(sheetId), board.date.substring(0, 4));
    if (replacing) dropDay(sheet, board.date);
    var from = sheet.getLastRow() + 1;
    // `setValues` writes into the grid that exists — it does not grow it, and
    // a default tab is 1000 rows, which ~200 rows a trading day fills in a
    // week. Without this the archive would die on about day five with an
    // out-of-bounds error and nothing else to show for it.
    growFor(sheet, from + rows.length - 1);
    sheet.getRange(from, 1, rows.length, SHEET_HEADER.length).setValues(rows);
    props.setProperty(
      SHEET_LAST_WRITE_PROP,
      board.date + ' ' + board.generated_at + ' ' + (replacing ? last.corrections + 1 : 0),
    );
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
  // `2026-09-21` into a value it hands back as a `Date` in the spreadsheet's
  // own timezone, and `dropDay` — which compares dates as strings — would
  // match nothing and duplicate the day it meant to replace. `cellDate` below
  // still tolerates a date cell, for a tab someone reformatted by hand.
  sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  return sheet;
}

/** Grows the tab so `lastNeeded` is inside the grid; `setValues` will not. */
function growFor(sheet, lastNeeded) {
  var max = sheet.getMaxRows();
  if (lastNeeded > max) sheet.insertRowsAfter(max, lastNeeded - max);
}

/**
 * Removes a date's rows so they can be rewritten. They are contiguous: rows
 * are only ever appended, one trading day at a time, and `validateBoard`
 * refuses a board whose trading date went backwards.
 */
function dropDay(sheet, date) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var first = -1;
  var count = 0;
  for (var i = 0; i < dates.length; i++) {
    if (cellDate(dates[i][0]) !== date) continue;
    if (first === -1) first = i + 2; // 1-based, past the header
    count++;
  }
  if (count) sheet.deleteRows(first, count);
  return count;
}

/**
 * A date cell as `yyyy-MM-dd`. Text comes back as itself; a cell Sheets parsed
 * as a date comes back as a `Date`, and its calendar parts are already in the
 * script's timezone, which is the one the manifest pins.
 */
function cellDate(value) {
  if (!value) return '';
  if (typeof value.getFullYear !== 'function') return String(value);
  var month = value.getMonth() + 1;
  var day = value.getDate();
  return value.getFullYear() + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
}

/** `"<ISO date> <generated_at> <corrections>"`, or null before the first write. */
function parseSheetWrite(value) {
  if (!value) return null;
  var parts = String(value).split(' ');
  return {
    date: parts[0] || '',
    generated_at: parts[1] || '',
    corrections: parseInt(parts[2] || '0', 10) || 0,
  };
}
