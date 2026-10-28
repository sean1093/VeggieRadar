/**
 * A crawl pushed from Taiwan (#103): MOA refuses connections from outside
 * Taiwan, and Apps Script runs abroad. `tools/push-board`, run on a machine in
 * Taiwan, fetches the day's rows with this backend's own crawl code and POSTs
 * them here; the board is then built, checked, stored, archived and mirrored
 * exactly as a refresh would — only the rows came from elsewhere.
 */

// The rows of a pushed crawl while `handlePush` runs a refresh on them, else
// null; `crawlBoard` takes them instead of asking MOA. Per execution.
var pushedCrawl = null;

/**
 * `POST ?action=push&token=…` with the crawl as the body. Operator only; a
 * malformed body changes nothing.
 * @returns {Object} what came of it: `stored` and why not, the board's date
 *   and count.
 */
function handlePush(body) {
  var crawl = parsePushedCrawl(body);
  if (crawl.error) return { type: 'push', stored: false, message: crawl.error };
  pushedCrawl = crawl;
  lastRefreshVerdict = null;
  var board;
  try {
    board = refreshBoardCache();
  } finally {
    pushedCrawl = null;
  }
  var verdict = lastRefreshVerdict || {};
  return {
    type: 'push',
    stored: !!verdict.ok,
    reasons: verdict.ok ? [] : (verdict.reasons || []),
    roc_date: board.roc_date || null,
    count: board.count || 0,
    generated_at: board.generated_at || null
  };
}

/**
 * The pushed body, checked and cut to what a crawl is: `{dates: {latest,
 * prev}, today: {root: rows[]}, prev: {root: rows[]}}`, the dates ROC and in
 * order, the roots the board's own, each row's plain values only. Anything
 * else is refused whole, rather than half a board stored from it.
 */
function parsePushedCrawl(body) {
  var text = String(body || '');
  if (!text) return { error: 'empty body' };
  if (text.length > PUSH_MAX_CHARS) return { error: 'body too large' };
  var data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { error: 'not JSON' };
  }
  if (!data || typeof data !== 'object') return { error: 'not an object' };
  var dates = data.dates || {};
  var latest = dates.latest;
  var prev = dates.prev === undefined ? null : dates.prev;
  if (typeof latest !== 'string' || !ROC_DAY.test(latest)) return { error: 'dates.latest must be a ROC date like 115.10.27' };
  if (prev !== null && (typeof prev !== 'string' || !ROC_DAY.test(prev) || prev >= latest)) {
    return { error: 'dates.prev must be an earlier ROC date, or null' };
  }
  // Taiwan's today, as the tool's and the script's clocks both read it.
  if (latest > dateToROC(new Date())) return { error: 'dates.latest is in the future' };
  var roots = {};
  var board = boardRoots();
  for (var i = 0; i < board.length; i++) roots[board[i]] = true;
  var today = pushedRows(data.today, roots);
  if (!today) return { error: 'today must map roots to rows' };
  var before = prev === null ? {} : pushedRows(data.prev, roots);
  if (!before) return { error: 'prev must map roots to rows' };
  return { dates: { latest: latest, prev: prev }, today: today, prev: before };
}

/** A root → rows map kept to the board's roots and each row's plain values; null when not a map. */
function pushedRows(byRoot, roots) {
  if (!byRoot || typeof byRoot !== 'object' || Array.isArray(byRoot)) return null;
  var out = {};
  for (var root in byRoot) {
    if (!Object.prototype.hasOwnProperty.call(roots, root) || !Array.isArray(byRoot[root])) continue;
    out[root] = byRoot[root].filter(function (row) {
      return row && typeof row === 'object' && !Array.isArray(row);
    }).map(function (row) {
      var plain = {};
      for (var key in row) {
        var v = row[key];
        if (typeof v === 'string' || typeof v === 'number') plain[key] = v;
      }
      return plain;
    });
  }
  return out;
}
