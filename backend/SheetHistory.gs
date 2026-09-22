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
 *     the same day, so a day is written once — and rewritten only when the
 *     numbers have actually moved on (closing prices complete late).
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
 * @returns {string} what it did, for tests and logs.
 */
function appendDailyHistory(board) {
  var props;
  var sheetId;
  var written;
  try {
    props = PropertiesService.getScriptProperties();
    sheetId = props.getProperty(HISTORY_SHEET_ID_PROP);
    written = props.getProperty(SHEET_LAST_WRITE_PROP);
  } catch (err) {
    Logger.log('appendDailyHistory: properties unavailable: ' + err);
    return 'unavailable';
  }
  if (!sheetId) return 'unconfigured';
  if (!board || !board.date || !board.roc_date || !board.items || !board.items.length) return 'nothing to write';

  // Was this trading day already archived, and has anything changed since?
  // MOA completes a day's closing prices during the evening, so the same date
  // crawled hours later is a correction worth keeping — and the same date
  // crawled again half an hour later is the same day twice.
  var last = parseSheetWrite(written);
  var replacing = false;
  if (last && last.date === board.date) {
    var moved = Date.parse(board.generated_at || '') - Date.parse(last.generated_at || '');
    if (!(moved > SHEET_CORRECTION_MS)) return 'already written';
    replacing = true;
  }

  try {
    var sheet = yearSheet(SpreadsheetApp.openById(sheetId), board.date.substring(0, 4));
    if (replacing) dropDay(sheet, board.date);
    var rows = historyRowsFor(board);
    if (!rows.length) return 'nothing to write';
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, SHEET_HEADER.length).setValues(rows);
    props.setProperty(SHEET_LAST_WRITE_PROP, board.date + ' ' + board.generated_at);
    Logger.log('appendDailyHistory: ' + rows.length + ' rows for ' + board.date + (replacing ? ' (replaced)' : ''));
    return replacing ? 'replaced' : 'appended';
  } catch (err) {
    // A wrong ID, a revoked share, an exhausted quota. The board is already
    // stored; this is the archive, and it can miss a day.
    Logger.log('appendDailyHistory failed: ' + err);
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
  return sheet;
}

/**
 * Removes a date's rows so they can be rewritten. They are contiguous: rows
 * are only ever appended, one trading day at a time.
 */
function dropDay(sheet, date) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var first = -1;
  var count = 0;
  for (var i = 0; i < dates.length; i++) {
    if (String(dates[i][0]) !== date) continue;
    if (first === -1) first = i + 2; // 1-based, past the header
    count++;
  }
  if (count) sheet.deleteRows(first, count);
  return count;
}

/** `"<ISO date> <generated_at>"`, or null before the first write. */
function parseSheetWrite(value) {
  if (!value) return null;
  var space = value.indexOf(' ');
  if (space === -1) return { date: value, generated_at: '' };
  return { date: value.substring(0, space), generated_at: value.substring(space + 1) };
}
