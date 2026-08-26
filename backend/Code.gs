/**
 * Google Apps Script (GAS) backend for VeggieRadar — Board-First Architecture
 *
 * Goal: 讓婆婆媽媽逛市場時，一打開就看到「今日常見菜價看板」，快速掃過、綠跌紅漲。
 *
 * How it works:
 *   - A daily time-trigger (`refreshBoardCache`) pre-warms a cached board so users
 *     never pay the crawl latency.
 *   - `doGet` (default) returns the cached board instantly.
 *   - `doGet?action=search&query=高麗菜` filters the board / falls back to a live query.
 *   - `doGet?action=getTrend&cropName=甘藍&days=7` returns a price trend.
 *
 * Data source: 農業部農產品批發市場交易行情 (open data, no key required).
 *   Endpoint : https://data.moa.gov.tw/api/v1/AgriProductsTransType/
 *   Dates    : ROC calendar, e.g. 115.08.26
 *   Prices   : 元 / 公斤
 */

// --- Configuration ---
var AGRICULTURE_API_URL = 'https://data.moa.gov.tw/api/v1/AgriProductsTransType/';
var MIN_TRADE_VOLUME = 200;      // 公斤，過濾零星交易
var CATTY_PER_KG = 0.6;          // 1 台斤 = 0.6 公斤
var BOARD_CACHE_KEY = 'veggie_board_v1';
var BOARD_CACHE_TTL = 6 * 60 * 60; // 6 小時
var MAX_LOOKBACK_DAYS = 8;       // 往前找最近一個有資料的交易日

/**
 * 看板品項：婆婆媽媽最常買的菜。
 * name     = 顯示用俗名
 * official = 農業部 API 的 CropName 前綴（會涵蓋所有品種與市場）
 * category = 前端分類篩選用
 */
var BOARD_ITEMS = [
  { name: '高麗菜', official: '甘藍',     category: '葉菜類' },
  { name: '小白菜', official: '小白菜',   category: '葉菜類' },
  { name: '青江菜', official: '青江白菜', category: '葉菜類' },
  { name: '空心菜', official: '蕹菜',     category: '葉菜類' },
  { name: '菠菜',   official: '菠菜',     category: '葉菜類' },
  { name: '萵苣',   official: '萵苣',     category: '葉菜類' },
  { name: '芥藍',   official: '芥藍',     category: '葉菜類' },
  { name: '韭菜',   official: '韭菜',     category: '葉菜類' },
  { name: '芹菜',   official: '芹菜',     category: '葉菜類' },
  { name: '花椰菜', official: '花椰菜',   category: '葉菜類' },
  { name: '白蘿蔔', official: '蘿蔔',     category: '根莖類' },
  { name: '紅蘿蔔', official: '胡蘿蔔',   category: '根莖類' },
  { name: '洋蔥',   official: '洋蔥',     category: '根莖類' },
  { name: '馬鈴薯', official: '馬鈴薯',   category: '根莖類' },
  { name: '番茄',   official: '番茄',     category: '果菜類' },
  { name: '茄子',   official: '茄子',     category: '果菜類' },
  { name: '青椒',   official: '青椒',     category: '果菜類' },
  { name: '甜椒',   official: '甜椒',     category: '果菜類' },
  { name: '玉米',   official: '玉米',     category: '果菜類' },
  { name: '敏豆',   official: '敏豆',     category: '果菜類' },
  { name: '苦瓜',   official: '苦瓜',     category: '瓜果類' },
  { name: '絲瓜',   official: '絲瓜',     category: '瓜果類' },
  { name: '大黃瓜', official: '胡瓜',     category: '瓜果類' },
  { name: '冬瓜',   official: '冬瓜',     category: '瓜果類' },
  { name: '南瓜',   official: '南瓜',     category: '瓜果類' },
  { name: '蔥',     official: '蔥',       category: '辛香類' },
  { name: '薑',     official: '薑',       category: '辛香類' },
  { name: '大蒜',   official: '大蒜',     category: '辛香類' },
  { name: '辣椒',   official: '辣椒',     category: '辛香類' },
  { name: '九層塔', official: '九層塔',   category: '辛香類' },
  { name: '豆芽',   official: '豆芽',     category: '其他' },
  { name: '香菇',   official: '香菇',     category: '其他' },
  { name: '金針菇', official: '金針菇',   category: '其他' },
  { name: '香蕉',   official: '香蕉',     category: '水果' },
  { name: '蘋果',   official: '蘋果',     category: '水果' },
  { name: '木瓜',   official: '木瓜',     category: '水果' },
  { name: '鳳梨',   official: '鳳梨',     category: '水果' },
  { name: '西瓜',   official: '西瓜',     category: '水果' }
];

/**
 * 俗名 → 農業部官方 CropName 別名表（給搜尋用）。
 * MOA 的 CropName 參數是「前綴比對」，多數輸入可直接命中；
 * 這裡只補常見的用詞落差。
 */
var SEARCH_ALIASES = {
  '高麗菜': '甘藍', '空心菜': '蕹菜', '青江菜': '青江白菜',
  '紅蘿蔔': '胡蘿蔔', '白蘿蔔': '蘿蔔', '地瓜葉': '甘藷葉',
  '四季豆': '敏豆', '大黃瓜': '胡瓜', '小黃瓜': '花胡瓜',
  'A菜': '萵苣', '大陸妹': '萵苣'
};

// --- Web App entry point ---
function doGet(e) {
  var params = (e && e.parameter) || {};
  var action = params.action || 'board';

  try {
    var payload;
    if (action === 'getTrend') {
      payload = handleTrend(params);
    } else if (action === 'search') {
      payload = handleSearch(params);
    } else if (action === 'warm') {
      payload = refreshBoardCache();
    } else {
      payload = readBoard();
    }
    return jsonOut(payload);
  } catch (err) {
    Logger.log('doGet error: ' + err);
    return jsonOut({ error: '系統錯誤，請稍後再試', message: String(err && err.message || err) });
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// --- Board ---

/**
 * Serves the board for user requests. NEVER crawls synchronously — a cold
 * crawl exceeds the Web App response window and returns an error page.
 * Order: in-memory cache → durable ScriptProperties → "warming" placeholder.
 */
function readBoard() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(BOARD_CACHE_KEY);
  if (cached) {
    var p = JSON.parse(cached);
    p.cached = true;
    return p;
  }
  var durable = PropertiesService.getScriptProperties().getProperty(BOARD_CACHE_KEY);
  if (durable) {
    cache.put(BOARD_CACHE_KEY, durable, BOARD_CACHE_TTL);
    var d = JSON.parse(durable);
    d.cached = true;
    return d;
  }
  // No data yet — trigger not run. Fast, non-crawling response.
  return { type: 'board', warming: true, count: 0, items: [] };
}

/**
 * Crawls the MOA API and assembles the board. Slow (many requests) — only ever
 * called from the time-driven trigger / manual setup, never from doGet.
 */
function buildBoard() {
  var dates = resolveTradeDates();
  if (!dates.latest) {
    return { type: 'board', error: '近期查無交易資料', items: [] };
  }

  var names = BOARD_ITEMS.map(function (d) { return d.official; });
  var today = fetchAllRows(names, dates.latest);
  var prev = dates.prev ? fetchAllRows(names, dates.prev) : {};

  var items = [];
  for (var i = 0; i < BOARD_ITEMS.length; i++) {
    var def = BOARD_ITEMS[i];
    var todayRows = today[def.official] || [];
    if (!todayRows.length) continue;
    var card = aggregateGroup(def.name, def.official, def.category, todayRows, prev[def.official] || []);
    if (card) items.push(card);
  }

  return {
    type: 'board',
    date: rocToISO(dates.latest),
    roc_date: dates.latest,
    prev_date: dates.prev,
    count: items.length,
    items: items
  };
}

/** Persists a healthy board to both the fast cache and durable properties. */
function storeBoard(payload) {
  var json = JSON.stringify(payload);
  CacheService.getScriptCache().put(BOARD_CACHE_KEY, json, BOARD_CACHE_TTL);
  try {
    if (json.length <= 9000) { // ScriptProperties per-value limit is 9KB
      PropertiesService.getScriptProperties().setProperty(BOARD_CACHE_KEY, json);
    }
  } catch (err) {
    Logger.log('storeBoard property error: ' + err);
  }
}

/** Time-driven trigger target — rebuilds and stores the board. */
function refreshBoardCache() {
  var board = buildBoard();
  if (board.items && board.items.length) {
    storeBoard(board);
  }
  Logger.log('Board refreshed: ' + (board.count || 0) + ' items');
  return board;
}

// --- Search ---

function handleSearch(params) {
  var query = (params.query || '').trim();
  if (!query) {
    return { type: 'search', error: '請輸入查詢關鍵字' };
  }

  // 1. Try the served board first — instant for common items (no crawl).
  var board = readBoard();
  if (board.items && board.items.length) {
    var hits = board.items.filter(function (it) {
      return it.name.indexOf(query) !== -1 || it.official_name.indexOf(query) !== -1;
    });
    if (hits.length) {
      return { type: 'search', query: query, date: board.date, count: hits.length, items: hits };
    }
  }

  // 2. Fall back to a live query against the MOA API.
  var term = SEARCH_ALIASES[query] || query;
  var dates = resolveTradeDates();
  if (!dates.latest) return { type: 'search', query: query, error: '近期查無交易資料', items: [] };

  var todayRows = fetchCrop(term, dates.latest);
  if (!todayRows.length) {
    return { type: 'search', query: query, error: '查無此品項', suggestion: '試試：高麗菜、番茄、青江菜' };
  }
  var prevRows = fetchCrop(term, dates.prev);

  // Group live results per official variant name (e.g. 番茄-黑柿, 番茄-牛番茄).
  var groups = {};
  for (var i = 0; i < todayRows.length; i++) {
    var nm = todayRows[i].CropName;
    (groups[nm] = groups[nm] || []).push(todayRows[i]);
  }
  var items = [];
  Object.keys(groups).forEach(function (nm) {
    var prevForName = prevRows.filter(function (r) { return r.CropName === nm; });
    var card = aggregateGroup(nm, nm, categoryOf(nm), groups[nm], prevForName);
    if (card) items.push(card);
  });
  items.sort(function (a, b) { return b.trade_volume - a.trade_volume; });

  if (!items.length) {
    return { type: 'search', query: query, error: '查無符合條件的品項（可能交易量過低）' };
  }
  return { type: 'search', query: query, date: rocToISO(dates.latest), count: items.length, items: items };
}

// --- Trend ---

function handleTrend(params) {
  var cropName = params.cropName;
  var days = parseInt(params.days || '7', 10);
  if (!cropName) return { error: '請提供 cropName 參數', message: '?action=getTrend&cropName=甘藍&days=7' };

  var term = SEARCH_ALIASES[cropName] || cropName;
  var trend = [];
  var today = new Date();
  for (var i = days - 1; i >= 0; i--) {
    var d = new Date(today);
    d.setDate(today.getDate() - i);
    var roc = dateToROC(d);
    var rows = fetchCrop(term, roc);
    if (rows.length) {
      var agg = weightedAverage(rows);
      trend.push(round1(agg.avg));
    } else {
      trend.push(null); // no market that day (e.g. weekend/holiday)
    }
    Utilities.sleep(80);
  }
  return { cropName: cropName, days: days, trend: trend };
}

// --- MOA API access ---

/**
 * Fetches all rows for a crop-name prefix on a given ROC date.
 * Single-crop queries stay well under the 1000-row page limit.
 */
function fetchCrop(cropName, rocDate) {
  var url = AGRICULTURE_API_URL + '?' + [
    'CropName=' + encodeURIComponent(cropName),
    'Start_time=' + encodeURIComponent(rocDate),
    'End_time=' + encodeURIComponent(rocDate)
  ].join('&');

  try {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return [];
    var json = JSON.parse(resp.getContentText());
    return (json && json.Data) ? json.Data : [];
  } catch (err) {
    Logger.log('fetchCrop error (' + cropName + ' ' + rocDate + '): ' + err);
    return [];
  }
}

/** Parses MOA rows from a single HTTPResponse. */
function parseRows(resp) {
  try {
    if (resp.getResponseCode() !== 200) return [];
    var json = JSON.parse(resp.getContentText());
    return (json && json.Data) ? json.Data : [];
  } catch (err) {
    return [];
  }
}

/**
 * Concurrently fetches rows for many crop-name prefixes on one ROC date.
 * Uses UrlFetchApp.fetchAll so the board crawl finishes within trigger limits.
 * @returns {Object} map of cropName → rows[]
 */
function fetchAllRows(cropNames, rocDate) {
  var requests = cropNames.map(function (name) {
    return {
      url: AGRICULTURE_API_URL + '?' + [
        'CropName=' + encodeURIComponent(name),
        'Start_time=' + encodeURIComponent(rocDate),
        'End_time=' + encodeURIComponent(rocDate)
      ].join('&'),
      muteHttpExceptions: true
    };
  });

  var out = {};
  try {
    var responses = UrlFetchApp.fetchAll(requests);
    for (var i = 0; i < responses.length; i++) {
      out[cropNames[i]] = parseRows(responses[i]);
    }
  } catch (err) {
    Logger.log('fetchAllRows error (' + rocDate + '): ' + err);
  }
  return out;
}

/** Finds the latest ROC date with data and the previous available date. */
function resolveTradeDates() {
  var probe = '甘藍'; // 全年、全市場、高交易量，最可靠的探針
  var today = new Date();
  var latest = null;
  var prev = null;

  for (var i = 0; i < MAX_LOOKBACK_DAYS && !latest; i++) {
    var d = new Date(today);
    d.setDate(today.getDate() - i);
    var roc = dateToROC(d);
    if (fetchCrop(probe, roc).length) latest = roc;
  }
  if (!latest) return { latest: null, prev: null };

  var latestDate = rocToDate(latest);
  for (var j = 1; j <= MAX_LOOKBACK_DAYS && !prev; j++) {
    var pd = new Date(latestDate);
    pd.setDate(latestDate.getDate() - j);
    var proc = dateToROC(pd);
    if (fetchCrop(probe, proc).length) prev = proc;
  }
  return { latest: latest, prev: prev };
}

// --- Aggregation ---

/**
 * Aggregates raw MOA rows (across markets/variants) into one board card.
 * Price = volume-weighted average of Avg_Price; change vs previous date.
 */
function aggregateGroup(displayName, officialName, category, todayRows, prevRows) {
  var today = weightedAverage(todayRows);
  if (today.volume < MIN_TRADE_VOLUME || today.avg <= 0) return null;

  var changePercent = 0;
  if (prevRows && prevRows.length) {
    var prev = weightedAverage(prevRows);
    if (prev.avg > 0) {
      changePercent = ((today.avg - prev.avg) / prev.avg) * 100;
    }
  }

  return {
    code: (todayRows[0] && todayRows[0].CropCode) || officialName,
    name: displayName,
    official_name: officialName,
    category: category,
    avg_price: round1(today.avg),
    catty_price: round1(today.avg * CATTY_PER_KG),
    change_percent: round1(changePercent),
    trade_volume: Math.round(today.volume),
    unit: '公斤',
    markets_count: today.markets
  };
}

/** Volume-weighted average price across rows. */
function weightedAverage(rows) {
  var priceQty = 0, totalQty = 0, markets = {};
  for (var i = 0; i < rows.length; i++) {
    var price = parseFloat(rows[i].Avg_Price || 0);
    var qty = parseFloat(rows[i].Trans_Quantity || 0);
    if (price > 0 && qty > 0) {
      priceQty += price * qty;
      totalQty += qty;
      markets[rows[i].MarketName] = true;
    }
  }
  return {
    avg: totalQty > 0 ? priceQty / totalQty : 0,
    volume: totalQty,
    markets: Object.keys(markets).length
  };
}

/** Best-effort category from crop name (used for live search results). */
function categoryOf(name) {
  for (var i = 0; i < BOARD_ITEMS.length; i++) {
    if (name.indexOf(BOARD_ITEMS[i].official) === 0) return BOARD_ITEMS[i].category;
  }
  if (/瓜/.test(name)) return '瓜果類';
  if (/菜|蔥|韭|芹|萵/.test(name)) return '葉菜類';
  return '其他';
}

// --- Date helpers (ROC calendar) ---

function dateToROC(d) {
  var y = d.getFullYear() - 1911;
  var m = ('0' + (d.getMonth() + 1)).slice(-2);
  var day = ('0' + d.getDate()).slice(-2);
  return y + '.' + m + '.' + day;
}

function rocToDate(roc) {
  var p = roc.split('.');
  return new Date(parseInt(p[0], 10) + 1911, parseInt(p[1], 10) - 1, parseInt(p[2], 10));
}

function rocToISO(roc) {
  var p = roc.split('.');
  var y = parseInt(p[0], 10) + 1911;
  return y + '-' + p[1] + '-' + p[2];
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// --- Setup helper: run once to install the daily refresh trigger ---
function installDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'refreshBoardCache') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('refreshBoardCache').timeBased().everyHours(6).create();
  refreshBoardCache();
}
