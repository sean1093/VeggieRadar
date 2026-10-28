/**
 * A crawl pushed from Taiwan (#103): MOA refuses connections from outside
 * Taiwan, and Apps Script runs abroad. `tools/push-board`, run on a machine in
 * Taiwan, fetches the day's rows with this backend's own crawl code and POSTs
 * them here; the board is then built, checked, stored, archived and mirrored
 * exactly as a refresh would — only the rows came from elsewhere.
 */

/**
 * `POST ?action=push&token=…` with the crawl as the body. Operator only; a
 * malformed body changes nothing.
 * @returns {Object} what came of it: `stored` and why not, the board's date
 *   and count.
 */
function handlePush(body) {
  var started = Date.now(); // the body's parse counts against the execution too
  var crawl = parsePushedCrawl(body);
  if (crawl.error) return { type: 'push', stored: false, message: crawl.error };
  var cache = CacheService.getScriptCache();
  if (cache.get(PUSH_LOCK_KEY)) {
    return { type: 'push', stored: false, busy: true, message: 'another push is still being stored: check ?action=diag in a few minutes' };
  }
  cache.put(PUSH_LOCK_KEY, '1', PUSH_LOCK_TTL);
  var refreshed;
  try {
    refreshed = refreshBoard(crawl, started);
  } finally {
    cache.remove(PUSH_LOCK_KEY);
  }
  var board = refreshed.board;
  var verdict = refreshed.verdict;
  var stored = verdict.ok && refreshed.durable;
  return {
    type: 'push',
    stored: stored,
    reasons: stored ? [] : verdict.ok
      // History, archive and mirror have it; the cache serves it for a few
      // hours, then the durable board before it. Pushing again fixes that.
      ? ['the board passed the guard and is served from the cache, but could not be written to the script properties: push again']
      : (verdict.reasons || []),
    roc_date: board.roc_date || null,
    count: board.count || 0,
    generated_at: board.generated_at || null
  };
}

/**
 * The pushed body, checked and cut to what a crawl is: `{dates: {latest,
 * prev}, today: {root: rows[]}, prev: {root: rows[]}}`. A body not of that
 * shape — dates not real ROC days in order, `today`/`prev` not maps, nothing
 * a card can be built from — is refused whole. Within it, what MOA would
 * never answer for that crawl is dropped (another root, another day's row, a
 * row without a `CropName`, any value but a string or number), and the guard
 * then judges what is left, as it judges any crawl.
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
  if (!isRocDay(latest)) return { error: 'dates.latest must be a ROC date like 115.10.27' };
  if (prev !== null && (!isRocDay(prev) || prev >= latest)) {
    return { error: 'dates.prev must be an earlier ROC date, or null' };
  }
  // Taiwan's today, as the tool's and the script's clocks both read it — with
  // a few minutes for the two clocks to disagree around midnight.
  if (latest > dateToROC(new Date(Date.now() + PUSH_CLOCK_SKEW_MS))) return { error: 'dates.latest is in the future' };
  var roots = {};
  var board = boardRoots();
  for (var i = 0; i < board.length; i++) roots[board[i]] = true;
  var today = pushedRows(data.today, roots, latest);
  if (!today) return { error: 'today must map roots to rows' };
  // Nothing to build a card from is no crawl: refused, not counted as a failed refresh.
  if (!boardCards(today, {}).length) return { error: 'today has no rows the board can use' };
  var before = prev === null ? {} : pushedRows(data.prev, roots, prev);
  if (!before) return { error: 'prev must map roots to rows' };
  return { dates: { latest: latest, prev: prev }, today: today, prev: before };
}

/** A real calendar day written as MOA writes it: `115.10.27`, never `115.13.40`. */
function isRocDay(value) {
  return typeof value === 'string' && ROC_DAY.test(value) && dateToROC(rocToDate(value)) === value;
}

/**
 * A root → rows map kept to the board's roots, to rows of `day` (a row naming
 * another `TransDate` is not that day's) with a `CropName`, and to each row's
 * plain values; null when not a map.
 */
function pushedRows(byRoot, roots, day) {
  if (!byRoot || typeof byRoot !== 'object' || Array.isArray(byRoot)) return null;
  var out = {};
  for (var root in byRoot) {
    if (!Object.prototype.hasOwnProperty.call(roots, root) || !Array.isArray(byRoot[root])) continue;
    out[root] = byRoot[root].filter(function (row) {
      return row && typeof row === 'object' && !Array.isArray(row) && typeof row.CropName === 'string' &&
        (row.TransDate === undefined || row.TransDate === day);
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
