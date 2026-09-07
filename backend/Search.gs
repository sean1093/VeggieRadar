/**
 * Search and trend: the two read paths that can fall through to a live
 * MOA query, and therefore the two that had to be made cheap.
 */


// --- Query normalisation ---

/**
 * The canonical form of a query. Same steps, same tables and the same fixture
 * as the client's `frontend/src/lib/normalizeQuery.ts`:
 * fold → de-simplify → de-suffix → one alias lookup. `backendCode.test.ts`
 * runs `shared/normalize-query.fixture.json` against this implementation and
 * `normalizeQuery.test.ts` runs it against the TypeScript one, so the two
 * cannot drift apart.
 */
function normalizeQuery(raw) {
  var terms = searchTerms(raw);
  return terms[terms.length - 1];
}

/**
 * Every form of a query worth matching: what the shopper typed, plus the MOA
 * root the alias table maps it to. Both are kept because they match different
 * things — 「蔥」 is a board name in its own right, while its alias 青蔥 is the
 * root behind 蔥 and 紅蔥頭.
 */
function searchTerms(raw) {
  var typed = stripQuerySuffixes(deSimplify(foldQuery(raw)));
  // `hasOwnProperty`, not a truthiness test: 「constructor」 is a typeable
  // string, and a plain lookup would answer it with Object's constructor.
  var canonical = SEARCH_ALIASES.hasOwnProperty(typed) ? SEARCH_ALIASES[typed] : typed;
  return typed === canonical ? [typed] : [typed, canonical];
}

/** Trim, full-width → half-width, collapse inner whitespace, lower-case. */
function foldQuery(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\uFF01-\uFF5E\u3000]/g, function (ch) {
      return ch === '\u3000' ? ' ' : String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    })
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Simplified → traditional over a small produce table — no OpenCC. Every key
 * exists only in simplified Chinese, so a query that already was Traditional
 * cannot be rewritten into something else.
 */
function deSimplify(query) {
  var out = '';
  for (var i = 0; i < query.length; i++) {
    var ch = query.charAt(i);
    out += SIMPLIFIED_TO_TRADITIONAL[ch] || ch;
  }
  return out;
}

/**
 * Drops question suffixes from the end: longest match first, so 「多少錢」 is
 * never shortened to 「多少」 plus a stray 錢, and repeatedly, because
 * 「洋蔥價格多少」 carries two. Never strips down to nothing — a query that IS
 * a suffix (「菜價」) is all the shopper gave us.
 */
function stripQuerySuffixes(query) {
  var out = query;
  for (;;) {
    var longest = '';
    for (var i = 0; i < QUERY_SUFFIXES.length; i++) {
      var suffix = QUERY_SUFFIXES[i];
      if (suffix.length > longest.length && out.length > suffix.length &&
          out.substring(out.length - suffix.length) === suffix) {
        longest = suffix;
      }
    }
    if (!longest) return out;
    out = out.substring(0, out.length - longest.length).trim();
  }
}

// --- Search ---

/**
 * Three steps, cheapest first:
 *
 *   1. the served board — most queries end here, with zero MOA traffic;
 *   2. the catalogue gate — a query no `CROP_CATALOG` root relates to cannot
 *      exist in the feed, so it is refused immediately instead of paying for a
 *      trading-date probe and two live queries. Typos, gibberish and
 *      non-produce searches all end here, which is where the 8–31 s went;
 *   3. a live query for the 1–3 roots that survived, cached per root for an
 *      hour so a burst of the same miss costs one crawl for everybody.
 */
function handleSearch(params) {
  var query = (params.query || '').trim();
  if (!query) {
    return { type: 'search', error: '請輸入查詢關鍵字' };
  }
  var terms = searchTerms(query);
  var board = readBoard();

  // 1. The board, which is a cache read.
  if (board.items && board.items.length) {
    var hits = board.items.filter(function (it) { return matchesTerms(it, terms); });
    if (hits.length) {
      return { type: 'search', query: query, date: board.date, count: hits.length, items: hits };
    }
  }

  // 2. The gate.
  var roots = catalogRoots(terms);
  if (!roots.length) {
    return { type: 'search', query: query, error: '查無此品項', suggestion: suggestFor(terms, board) };
  }

  // 3. The live query, per surviving root.
  var items = [];
  var date = null;
  var rows = 0;
  for (var i = 0; i < roots.length; i++) {
    var live = liveRootCards(roots[i]);
    if (!live) continue; // no trading date at all — nothing to serve or cache
    if (!date) date = live.date;
    rows += live.rows;
    for (var j = 0; j < live.items.length; j++) {
      if (!hasOfficial(items, live.items[j].official_name)) items.push(live.items[j]);
    }
  }
  if (!date) return { type: 'search', query: query, error: '近期查無交易資料', items: [] };
  if (!rows) return { type: 'search', query: query, error: '查無此品項', suggestion: suggestFor(terms, board) };
  if (!items.length) {
    return { type: 'search', query: query, error: '查無符合條件的品項（可能交易量過低）' };
  }
  items.sort(function (a, b) { return b.trade_volume - a.trade_volume; });
  return { type: 'search', query: query, date: date, count: items.length, items: items };
}

/** A board row the query means: display name (case-insensitive) or MOA root. */
function matchesTerms(item, terms) {
  var name = (item.name || '').toLowerCase();
  var official = item.official_name || '';
  for (var i = 0; i < terms.length; i++) {
    if (!terms[i]) continue;
    if (name.indexOf(terms[i]) !== -1 || official.indexOf(terms[i]) !== -1) return true;
  }
  return false;
}

/**
 * The catalogue roots a query could mean, most specific first: an exact root,
 * then roots that contain the query (「蓮」 → 蓮子, 蓮藕, 蓮霧), then a root
 * contained in it. Shorter containing roots rank first — a two-character root
 * is the crop, a longer one is a speciality of it. Capped at
 * `SEARCH_MAX_ROOTS`, because each root costs a live query.
 */
function catalogRoots(terms) {
  var exact = [];
  var contains = [];
  var contained = [];
  for (var i = 0; i < CROP_CATALOG.length; i++) {
    var root = CROP_CATALOG[i];
    for (var t = 0; t < terms.length; t++) {
      var term = terms[t];
      if (!term) continue;
      if (root === term) { exact.push(root); break; }
      if (root.indexOf(term) !== -1) { contains.push(root); break; }
      if (term.indexOf(root) !== -1) { contained.push(root); break; }
    }
  }
  contains.sort(function (a, b) { return a.length - b.length || (a < b ? -1 : 1); });
  var picked = [];
  var pool = exact.concat(contains, contained);
  for (var p = 0; p < pool.length && picked.length < SEARCH_MAX_ROOTS; p++) {
    if (picked.indexOf(pool[p]) === -1) picked.push(pool[p]);
  }
  return picked;
}

/**
 * One root's cards from a live MOA query, cached for an hour and shared by
 * every visitor — the same policy the trend uses. The key carries today's
 * date, not the trading date, so a warm cache answers without the
 * trading-date probe; the payload carries the trading date it was built from.
 */
function liveRootCards(root) {
  var cache = CacheService.getScriptCache();
  var cacheKey = SEARCH_CACHE_PREFIX + root + '_' + dateToROC(new Date());
  var hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);

  var dates = resolveTradeDates();
  if (!dates.latest) return null; // never cache a failed probe

  var todayRows = tradedRows(fetchCrop(root, dates.latest));
  // A root that did not trade today needs no second query to prove it.
  var prevRows = todayRows.length ? tradedRows(fetchCrop(root, dates.prev)) : [];

  // MOA matches `CropName` as a substring, so one query answers with every
  // related root (蘿蔔 also brings 胡蘿蔔). Grouping by root keeps a search
  // behaving like the board instead of blending two crops into one average.
  var groups = {};
  var order = [];
  for (var i = 0; i < todayRows.length; i++) {
    var rowName = rowRoot(todayRows[i].CropName);
    if (!groups[rowName]) { groups[rowName] = []; order.push(rowName); }
    groups[rowName].push(todayRows[i]);
  }
  var items = [];
  for (var k = 0; k < order.length; k++) {
    var name = order[k];
    var prevForRoot = prevRows.filter(function (r) { return rowRoot(r.CropName) === name; });
    var def = { name: name, official: name, category: categoryOf(name) };
    var card = aggregateGroup(def, groups[name], prevForRoot);
    if (card) items.push(card);
  }

  var payload = { date: rocToISO(dates.latest), rows: todayRows.length, items: items };
  cache.put(cacheKey, JSON.stringify(payload), SEARCH_CACHE_TTL);
  return payload;
}

function hasOfficial(items, officialName) {
  for (var i = 0; i < items.length; i++) {
    if (items[i].official_name === officialName) return true;
  }
  return false;
}

/**
 * What to offer when nothing matched. A catalogue root one edit away is a
 * typo 「did you mean」; with none, the board's biggest sellers are the honest
 * answer, because a shopper who typed something unrelated is best served by
 * what is actually trading. A string rather than a list: it is rendered as
 * one line, and the clients that already read `suggestion` expect text.
 */
function suggestFor(terms, board) {
  var names = nearRoots(terms);
  if (!names.length) names = popularNames(board);
  return '試試：' + names.join('、');
}

/**
 * Catalogue roots within one edit of the query. Single-character queries are
 * skipped: at that length every unrelated one-character root is one edit away,
 * so the suggestion would be noise rather than a correction.
 */
function nearRoots(terms) {
  var near = [];
  for (var i = 0; i < CROP_CATALOG.length && near.length < SEARCH_MAX_SUGGESTIONS; i++) {
    var root = CROP_CATALOG[i];
    for (var t = 0; t < terms.length; t++) {
      var term = terms[t];
      if (!term || term.length < 2 || root === term) continue;
      if (withinOneEdit(root, term)) { near.push(root); break; }
    }
  }
  return near;
}

/** True when one insertion, deletion or substitution turns `a` into `b`. */
function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    var diffs = 0;
    for (var i = 0; i < a.length; i++) {
      if (a.charAt(i) !== b.charAt(i) && ++diffs > 1) return false;
    }
    return true;
  }
  var longer = a.length > b.length ? a : b;
  var shorter = a.length > b.length ? b : a;
  var skipped = false;
  for (var j = 0, k = 0; j < longer.length; j++) {
    if (longer.charAt(j) === shorter.charAt(k)) { k++; continue; }
    if (skipped) return false;
    skipped = true;
  }
  return true;
}

/**
 * The board's best sellers, or — before any board exists — the first items of
 * the definition, which is ordered by how everyday the crop is.
 */
function popularNames(board) {
  var names = [];
  if (board && board.items && board.items.length) {
    var byVolume = board.items.slice().sort(function (a, b) {
      return (b.trade_volume || 0) - (a.trade_volume || 0);
    });
    for (var i = 0; i < byVolume.length && names.length < SEARCH_MAX_SUGGESTIONS; i++) {
      names.push(byVolume[i].name);
    }
    return names;
  }
  for (var j = 0; j < BOARD_ITEMS.length && names.length < SEARCH_MAX_SUGGESTIONS; j++) {
    names.push(BOARD_ITEMS[j].name);
  }
  return names;
}

// --- Trend ---

/**
 * Price trend for the drawer. ONE range query replaces the previous
 * fetch-per-day loop, and the payload is cached for every user, so trend load
 * no longer scales with traffic. Response shape is unchanged: oldest → newest,
 * `null` on non-trading days — including today until closing prices publish.
 */
function handleTrend(params) {
  var cropName = params.cropName;
  if (!cropName) return { error: '請提供 cropName 參數', message: '?action=getTrend&cropName=甘藍&days=7' };
  var days = parseInt(params.days || '7', 10);
  if (isNaN(days) || days < 1) days = 7;
  if (days > TREND_MAX_DAYS) days = TREND_MAX_DAYS;

  var term = normalizeQuery(cropName);
  var root = rowRoot(term);
  var today = new Date();

  var cache = CacheService.getScriptCache();
  var cacheKey = TREND_CACHE_PREFIX + root + '_' + days + '_' + dateToROC(today);
  var hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);

  var start = new Date(today);
  start.setDate(today.getDate() - (days - 1));
  var rows = tradedRows(fetchCrop(term, dateToROC(start), dateToROC(today))).filter(function (r) {
    return rowRoot(r.CropName) === root;
  });

  // Group rows by trading date, then walk the calendar so closed days stay null.
  var byDate = {};
  for (var i = 0; i < rows.length; i++) {
    var dateKey = rows[i].TransDate;
    (byDate[dateKey] = byDate[dateKey] || []).push(rows[i]);
  }

  var trend = [];
  for (var offset = days - 1; offset >= 0; offset--) {
    var d = new Date(today);
    d.setDate(today.getDate() - offset);
    var dayRows = byDate[dateToROC(d)];
    trend.push(dayRows ? round1(weightedAverage(dayRows).avg) : null);
  }

  var payload = { cropName: cropName, days: days, trend: trend };
  cache.put(cacheKey, JSON.stringify(payload), TREND_CACHE_TTL);
  return payload;
}
