/**
 * Search and trend: the two read paths that can fall through to a live
 * MOA query, and therefore the two that had to be made cheap.
 */


// --- Search ---

function handleSearch(params) {
  var query = (params.query || '').trim();
  if (!query) {
    return { type: 'search', error: '請輸入查詢關鍵字' };
  }
  var q = query.toLowerCase();

  // 1. Try the served board first — instant for common items (no crawl).
  var board = readBoard();
  if (board.items && board.items.length) {
    var hits = board.items.filter(function (it) {
      return it.name.toLowerCase().indexOf(q) !== -1 || it.official_name.indexOf(query) !== -1;
    });
    if (hits.length) {
      return { type: 'search', query: query, date: board.date, count: hits.length, items: hits };
    }
  }

  // 2. Fall back to a live query against the MOA API (needs a Chinese CropName).
  var term = SEARCH_ALIASES[q] || SEARCH_ALIASES[query] || query;
  var dates = resolveTradeDates();
  if (!dates.latest) return { type: 'search', query: query, error: '近期查無交易資料', items: [] };

  var todayRows = tradedRows(fetchCrop(term, dates.latest));
  if (!todayRows.length) {
    return { type: 'search', query: query, error: '查無此品項', suggestion: '試試：高麗菜、番茄、菠菜' };
  }
  var prevRows = tradedRows(fetchCrop(term, dates.prev));

  // Group live results by MOA root so a search behaves like the board.
  var groups = {};
  for (var i = 0; i < todayRows.length; i++) {
    var root = rowRoot(todayRows[i].CropName);
    (groups[root] = groups[root] || []).push(todayRows[i]);
  }
  var items = [];
  Object.keys(groups).forEach(function (root) {
    var prevForRoot = prevRows.filter(function (r) { return rowRoot(r.CropName) === root; });
    var def = { name: root, official: root, category: categoryOf(root) };
    var card = aggregateGroup(def, groups[root], prevForRoot);
    if (card) items.push(card);
  });
  items.sort(function (a, b) { return b.trade_volume - a.trade_volume; });

  if (!items.length) {
    return { type: 'search', query: query, error: '查無符合條件的品項（可能交易量過低）' };
  }
  return { type: 'search', query: query, date: rocToISO(dates.latest), count: items.length, items: items };
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

  var term = SEARCH_ALIASES[cropName] || cropName;
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
