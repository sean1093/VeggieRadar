/**
 * Google Apps Script (GAS) backend for VeggieRadar — Board-First Architecture
 *
 * Goal: shoppers open the app and instantly see today's common produce prices
 *       at a glance — green when cheaper, clay when pricier — plus an estimated
 *       traditional-market retail band they can use while standing at the stall.
 *
 * How it works:
 *   - A time-trigger (`refreshBoardCache`) pre-warms a cached board so users
 *     never pay the crawl latency.
 *   - `doGet` (default) returns the cached board instantly, tagged with
 *     `generated_at` (when the backend last crawled) so the client can tell
 *     "markets were closed" apart from "our pipeline is dead". A board older
 *     than `BOARD_MAX_AGE_MS` schedules a background rebuild on the spot, so a
 *     dead trigger self-heals instead of freezing the app on an old date.
 *   - `doGet?action=search&query=<name>` filters the board / falls back to a live query.
 *   - `doGet?action=getTrend&cropName=<name>&days=7` returns a price trend,
 *     served from a shared cache and crawled with ONE range query.
 *   - `doGet?action=warm` queues a rebuild and returns immediately.
 *   - `doGet?action=backfill` queues a one-time history seed for baselines.
 *   - `doGet?action=diag` reports board freshness and trigger state.
 *
 * Data source: Taiwan MOA wholesale market transactions (open data, no key required).
 *   Endpoint : https://data.moa.gov.tw/api/v1/AgriProductsTransType/
 *   Dates    : ROC calendar, e.g. 115.08.26
 *   Prices   : NT$ / kg
 *
 * Two MOA quirks drive the shape of this file:
 *
 *   1. `CropName` is matched as a SUBSTRING of the full `<root>-<variety>` name,
 *      not as a prefix. Querying `蔥` returns 洋蔥 (onion) and 大蒜-蔥蒜; querying
 *      `蘿蔔` returns 胡蘿蔔 (carrot); querying `胡瓜` returns 花胡瓜 (小黃瓜).
 *      Every board item therefore declares the exact `root` it wants, plus an
 *      optional variety include/exclude, and rows are filtered locally.
 *
 *   2. On a day a market is closed — including today before the closing prices
 *      publish — MOA returns placeholder rows with `CropName: "休市"` and zeroed
 *      price/quantity. Those rows must never count as "this date has data".
 */

// --- Configuration ---
var AGRICULTURE_API_URL = 'https://data.moa.gov.tw/api/v1/AgriProductsTransType/';
var MIN_TRADE_VOLUME = 200;      // kg; filters out sparse trades for one item
var PROBE_MIN_VOLUME = 50000;    // kg; a real island-wide trading day for the probe crop
var CATTY_PER_KG = 0.6;          // 1 catty = 0.6 kg
var BOARD_CACHE_KEY = 'veggie_board_v2';
var BOARD_CACHE_TTL = 6 * 60 * 60; // 6 hours
var MAX_LOOKBACK_DAYS = 8;       // walk back to the latest day that has data
var FETCH_BATCH = 13;            // concurrent UrlFetchApp requests; a 70+ burst trips MOA's per-IP limit
// Trend serving. One drawer open used to cost 7 sequential MOA fetches plus
// 480 ms of sleeps; a range query and a short shared cache make it at most
// 1 fetch per crop per hour across ALL users, keeping the URLFetch daily quota
// and the 30-simultaneous-execution cap far away as traffic grows.
var TREND_CACHE_PREFIX = 'veggie_trend_';
var TREND_CACHE_TTL = 60 * 60;   // seconds; bounds staleness once closing prices publish
var TREND_MAX_DAYS = 14;         // MOA caps one response near 1000 rows; 14 days stays under it
var TRADE_DATES_CACHE_KEY = 'veggie_trade_dates';
var TRADE_DATES_TTL = 60 * 60;   // seconds; saves up to 16 probe fetches per search miss

// Durable board storage. ScriptProperties caps a single value at 9 KB and the
// board is ~25 KB, so it is written as numbered chunks.
var BOARD_PROP_PREFIX = 'veggie_board_v2_chunk_';
var BOARD_PROP_COUNT = 'veggie_board_v2_chunks';
var PROP_CHUNK_SIZE = 8000;

// Freshness. `date`/`roc_date` is the trading date of the prices — it legitimately
// stays put over weekends, holidays and typhoon closures, when MOA publishes only
// `休市` rows. `generated_at` is when we last crawled, which must keep moving; a
// board that stops being regenerated is the actual failure mode.
var BOARD_MAX_AGE_MS = 4 * 60 * 60 * 1000; // rebuild on demand past this age
var REFRESH_LOCK_KEY = 'veggie_refresh_queued';
var REFRESH_LOCK_TTL = 15 * 60;            // seconds; one queued rebuild per window
var REFRESH_ONCE_FN = 'refreshBoardCacheOnce';
var REFRESH_CRON_FN = 'refreshBoardCache';
var LAST_OK_PROP = 'veggie_last_refresh_ok';
var LAST_FAIL_PROP = 'veggie_last_refresh_fail';
// Per-item wholesale price history, appended by the 4-hourly refresh (zero
// extra MOA traffic) and seeded once through `?action=backfill`. It powers
// the "vs the usual price" baseline: the median of up to BASELINE_WINDOW
// recent trading days. The calendar horizon keeps a crop returning from
// months out of season from being judged against stale prices.
var HISTORY_PROP_PREFIX = 'veggie_history_chunk_';
var HISTORY_PROP_COUNT = 'veggie_history_chunks';
var BASELINE_WINDOW = 28;        // trading days kept per item
var BASELINE_MIN_DAYS = 10;      // fewer observations → no baseline published
var BASELINE_HORIZON_DAYS = 45;  // calendar days; older entries are pruned
var BACKFILL_ONCE_FN = 'backfillHistoryOnce';
var BACKFILL_LOCK_KEY = 'veggie_backfill_queued';
var BACKFILL_LOCK_TTL = 60 * 60; // seconds; one queued backfill per hour
var BACKFILL_WINDOW_DAYS = 12;   // per range request; high-volume roots stay under MOA's ~1000-row cap
var BACKFILL_WINDOWS = 2;        // 24 calendar days ≈ 20 trading days on day one; dailies top up the rest

/**
 * Board items: the produce people actually buy.
 *
 * name     = display name (Chinese; shown in the UI)
 * official = EXACT MOA root name, i.e. the part of `CropName` before the first
 *            '-'. Verified against the live API — several differ from the
 *            colloquial name (地瓜葉 = 甘薯葉, 山藥 = 薯蕷, 蒲瓜 = 扁蒲,
 *            佛手瓜 = 隼人瓜, 香瓜 = 甜瓜, 木耳 = 濕木耳, 金針菇 = 金絲菇).
 * variety  = optional; keep only rows whose variety part contains this string.
 * excludes = optional; drop rows whose variety part contains any of these.
 * category = category shown in the front-end filter (Chinese)
 *
 * Out-of-season items simply return no rows and are skipped, so the board is
 * seasonal by construction.
 */
var BOARD_ITEMS = [
  // 葉菜類
  { name: '高麗菜',   official: '甘藍',       category: '葉菜類' },
  { name: '大白菜',   official: '包心白菜',   category: '葉菜類' },
  { name: '小白菜',   official: '小白菜',     category: '葉菜類' },
  { name: '青江菜',   official: '青江白菜',   category: '葉菜類' },
  { name: '空心菜',   official: '蕹菜',       category: '葉菜類' },
  { name: '地瓜葉',   official: '甘薯葉',     category: '葉菜類' },
  { name: '菠菜',     official: '菠菜',       category: '葉菜類' },
  { name: '萵苣',     official: '萵苣菜',     category: '葉菜類' },
  { name: '芥藍',     official: '芥藍菜',     category: '葉菜類' },
  { name: '莧菜',     official: '莧菜',       category: '葉菜類' },
  { name: '茼蒿',     official: '茼蒿',       category: '葉菜類' },
  { name: '油菜',     official: '油菜',       category: '葉菜類' },
  { name: '芥菜',     official: '芥菜',       category: '葉菜類' },
  { name: '皇宮菜',   official: '皇宮菜',     category: '葉菜類' },
  { name: '韭菜',     official: '韭菜',       category: '葉菜類' },
  { name: '芹菜',     official: '芹菜',       category: '葉菜類' },
  { name: '芫荽',     official: '芫荽',       category: '葉菜類' },
  { name: '過貓',     official: '蕨菜',       category: '葉菜類' },
  { name: '蘆筍',     official: '蘆筍',       category: '葉菜類' },
  { name: '白花椰菜', official: '花椰菜',     category: '葉菜類', variety: '白' },
  { name: '青花菜',   official: '花椰菜',     category: '葉菜類', variety: '青' },

  // 根莖類
  { name: '白蘿蔔',   official: '蘿蔔',       category: '根莖類', excludes: ['甜菜根', '櫻桃'] },
  { name: '紅蘿蔔',   official: '胡蘿蔔',     category: '根莖類' },
  { name: '洋蔥',     official: '洋蔥',       category: '根莖類' },
  { name: '馬鈴薯',   official: '馬鈴薯',     category: '根莖類' },
  { name: '地瓜',     official: '甘薯',       category: '根莖類' },
  { name: '芋頭',     official: '芋',         category: '根莖類' },
  { name: '山藥',     official: '薯蕷',       category: '根莖類' },
  { name: '牛蒡',     official: '牛蒡',       category: '根莖類' },
  { name: '竹筍',     official: '竹筍',       category: '根莖類' },
  { name: '茭白筍',   official: '茭白筍',     category: '根莖類' },
  { name: '蓮藕',     official: '蓮藕',       category: '根莖類' },
  { name: '豆薯',     official: '豆薯',       category: '根莖類' },

  // 果菜類
  { name: '番茄',     official: '番茄',       category: '果菜類' },
  { name: '小番茄',   official: '小番茄',     category: '果菜類' },
  { name: '茄子',     official: '茄子',       category: '果菜類' },
  { name: '青椒',     official: '甜椒',       category: '果菜類', variety: '青椒' },
  { name: '甜椒',     official: '甜椒',       category: '果菜類', excludes: ['青椒'] },
  { name: '玉米',     official: '玉米',       category: '果菜類', excludes: ['玉米筍'] },
  { name: '玉米筍',   official: '玉米',       category: '果菜類', variety: '玉米筍' },
  { name: '四季豆',   official: '敏豆',       category: '果菜類' },
  { name: '菜豆',     official: '菜豆',       category: '果菜類' },
  { name: '豌豆',     official: '豌豆',       category: '果菜類' },
  { name: '秋葵',     official: '秋葵',       category: '果菜類' },

  // 瓜果類
  { name: '苦瓜',     official: '苦瓜',       category: '瓜果類' },
  { name: '絲瓜',     official: '絲瓜',       category: '瓜果類' },
  { name: '大黃瓜',   official: '胡瓜',       category: '瓜果類' },
  { name: '小黃瓜',   official: '花胡瓜',     category: '瓜果類' },
  { name: '冬瓜',     official: '冬瓜',       category: '瓜果類' },
  { name: '南瓜',     official: '南瓜',       category: '瓜果類' },
  { name: '蒲瓜',     official: '扁蒲',       category: '瓜果類' },
  { name: '佛手瓜',   official: '隼人瓜',     category: '瓜果類' },

  // 辛香類
  { name: '蔥',       official: '青蔥',       category: '辛香類', excludes: ['紅蔥頭'] },
  { name: '紅蔥頭',   official: '青蔥',       category: '辛香類', variety: '紅蔥頭' },
  { name: '薑',       official: '薑',         category: '辛香類' },
  { name: '大蒜',     official: '大蒜',       category: '辛香類' },
  { name: '辣椒',     official: '辣椒',       category: '辛香類' },
  { name: '九層塔',   official: '九層塔',     category: '辛香類' },

  // 菇類
  { name: '香菇',     official: '濕香菇',     category: '菇類' },
  { name: '金針菇',   official: '金絲菇',     category: '菇類' },
  { name: '杏鮑菇',   official: '杏鮑菇',     category: '菇類' },
  { name: '鴻喜菇',   official: '鴻喜菇',     category: '菇類' },
  { name: '洋菇',     official: '洋菇',       category: '菇類' },
  { name: '秀珍菇',   official: '秀珍菇',     category: '菇類' },
  { name: '木耳',     official: '濕木耳',     category: '菇類' },

  // 水果
  { name: '香蕉',     official: '香蕉',       category: '水果' },
  { name: '蘋果',     official: '蘋果',       category: '水果' },
  { name: '木瓜',     official: '木瓜',       category: '水果' },
  { name: '鳳梨',     official: '鳳梨',       category: '水果' },
  { name: '西瓜',     official: '西瓜',       category: '水果' },
  { name: '香瓜',     official: '甜瓜',       category: '水果' },
  { name: '哈密瓜',   official: '洋香瓜',     category: '水果' },
  { name: '芭樂',     official: '番石榴',     category: '水果' },
  { name: '火龍果',   official: '紅龍果',     category: '水果' },
  { name: '葡萄',     official: '葡萄',       category: '水果' },
  { name: '芒果',     official: '芒果',       category: '水果' },
  { name: '荔枝',     official: '荔枝',       category: '水果' },
  { name: '龍眼',     official: '龍眼',       category: '水果' },
  { name: '梨',       official: '梨',         category: '水果' },
  { name: '桃子',     official: '桃子',       category: '水果' },
  { name: '李子',     official: '李',         category: '水果' },
  { name: '棗子',     official: '棗子',       category: '水果' },
  { name: '柿子',     official: '柿子',       category: '水果', excludes: ['柿餅'] },
  { name: '蓮霧',     official: '蓮霧',       category: '水果' },
  { name: '釋迦',     official: '釋迦',       category: '水果' },
  { name: '楊桃',     official: '楊桃',       category: '水果' },
  { name: '百香果',   official: '百香果',     category: '水果' },
  { name: '枇杷',     official: '枇杷',       category: '水果' },
  { name: '檸檬',     official: '雜柑',       category: '水果', variety: '檸檬' },
  { name: '柳丁',     official: '甜橙',       category: '水果' },
  { name: '椪柑',     official: '椪柑',       category: '水果' },
  { name: '桶柑',     official: '桶柑',       category: '水果' },
  { name: '海梨柑',   official: '海梨柑',     category: '水果' },
  { name: '茂谷柑',   official: '茂谷柑',     category: '水果' },
  { name: '柚子',     official: '柚子',       category: '水果' },
  { name: '葡萄柚',   official: '葡萄柚',     category: '水果' },
  { name: '酪梨',     official: '酪梨',       category: '水果' },
  { name: '奇異果',   official: '奇異果',     category: '水果' },
  { name: '草莓',     official: '草莓',       category: '水果' },
  { name: '櫻桃',     official: '櫻桃',       category: '水果' },
  { name: '藍莓',     official: '藍莓',       category: '水果' },
  { name: '椰子',     official: '椰子',       category: '水果' },

  // 其他
  { name: '豆芽',     official: '芽菜類',     category: '其他' },
  { name: '海菜',     official: '海菜',       category: '其他' }
];

/**
 * Estimated traditional-market retail markup, in 元/台斤 ADDED to the wholesale
 * catty price. Additive rather than multiplicative because a stall's margin is
 * driven by handling, shrinkage and rent amortised per unit sold, not by a
 * percentage: a NT$9/catty cabbage retails around NT$35, a 4x ratio, while a
 * NT$41/catty pear retails around NT$67, a 1.6x ratio. The same NT$25-30
 * absolute markup explains both.
 *
 * Calibrated against real municipal retail data joined to MOA wholesale on the
 * same dates:
 *   - 臺中市公有零售市場每日蔬果價格表 (14 markets, daily, 元/台斤) — 365 days
 *   - 臺北市公有零售市場行情 (122 items, monthly, 元/台斤) — 114年12月
 * Median absolute error of the midpoint is 7-24% depending on category, so the
 * UI must present a band and label it an estimate — never a quoted price.
 */
var RETAIL_MARKUP_ROOT = {
  // Each entry has >= 5 paired retail/wholesale observations across 25 dates.
  '包心白菜': 24, '大蒜': 68, '小番茄': 59, '木瓜': 29, '柚子': 49, '柿子': 57,
  '桶柑': 31, '梨': 36, '棗子': 49, '椪柑': 34, '洋蔥': 18, '甘藍': 29,
  '番石榴': 20, '紅龍果': 38, '絲瓜': 27, '胡瓜': 28, '胡蘿蔔': 18, '芒果': 33,
  '花椰菜': 36, '花胡瓜': 22, '茂谷柑': 50, '荔枝': 22, '蓮霧': 52, '蕹菜': 21,
  '蘿蔔': 20, '西瓜': 18, '青江白菜': 33, '青蔥': 51, '香蕉': 14, '鳳梨': 13
};

/** Per-category fallback [low, mid, high] markup in 元/台斤. */
var RETAIL_MARKUP_CATEGORY = {
  '葉菜類': [20, 35, 50],
  '根莖類': [19, 28, 48],
  '果菜類': [48, 70, 88],
  '瓜果類': [22, 32, 50],
  '辛香類': [45, 55, 80],
  '菇類':   [40, 60, 85],
  '水果':   [17, 32, 62],
  '其他':   [20, 35, 50]
};

/** Band width applied to a per-root markup, which is a midpoint only. */
var RETAIL_BAND_LOW = 0.75;
var RETAIL_BAND_HIGH = 1.35;

/**
 * Search aliases → MOA root name (Chinese; the API only accepts Chinese).
 * Covers common English and colloquial terms plus the many cases where the
 * everyday name is not the MOA root name.
 */
var SEARCH_ALIASES = {
  // English → MOA root
  'cabbage': '甘藍', 'napa cabbage': '包心白菜', 'bok choy': '小白菜',
  'baby bok choy': '青江白菜', 'water spinach': '蕹菜', 'sweet potato leaf': '甘薯葉',
  'spinach': '菠菜', 'lettuce': '萵苣菜', 'chinese kale': '芥藍菜', 'kale': '芥藍菜',
  'amaranth': '莧菜', 'chrysanthemum greens': '茼蒿', 'mustard greens': '芥菜',
  'chives': '韭菜', 'celery': '芹菜', 'cilantro': '芫荽', 'coriander': '芫荽',
  'asparagus': '蘆筍', 'cauliflower': '花椰菜', 'broccoli': '花椰菜',
  'daikon': '蘿蔔', 'radish': '蘿蔔', 'carrot': '胡蘿蔔', 'onion': '洋蔥',
  'potato': '馬鈴薯', 'sweet potato': '甘薯', 'taro': '芋', 'yam': '薯蕷',
  'burdock': '牛蒡', 'bamboo shoot': '竹筍', 'water bamboo': '茭白筍',
  'lotus root': '蓮藕', 'jicama': '豆薯',
  'tomato': '番茄', 'cherry tomato': '小番茄', 'eggplant': '茄子',
  'green pepper': '甜椒', 'bell pepper': '甜椒', 'pepper': '甜椒',
  'corn': '玉米', 'baby corn': '玉米', 'green bean': '敏豆', 'string bean': '敏豆',
  'yard long bean': '菜豆', 'pea': '豌豆', 'okra': '秋葵',
  'bitter gourd': '苦瓜', 'luffa': '絲瓜', 'cucumber': '花胡瓜',
  'winter melon': '冬瓜', 'pumpkin': '南瓜', 'bottle gourd': '扁蒲',
  'chayote': '隼人瓜',
  'scallion': '青蔥', 'green onion': '青蔥', 'shallot': '青蔥', 'ginger': '薑',
  'garlic': '大蒜', 'chili': '辣椒', 'chili pepper': '辣椒',
  'thai basil': '九層塔', 'basil': '九層塔',
  'shiitake': '濕香菇', 'mushroom': '濕香菇', 'enoki': '金絲菇',
  'king oyster mushroom': '杏鮑菇', 'shimeji': '鴻喜菇', 'button mushroom': '洋菇',
  'oyster mushroom': '秀珍菇', 'wood ear': '濕木耳', 'bean sprouts': '芽菜類',
  'banana': '香蕉', 'apple': '蘋果', 'papaya': '木瓜', 'pineapple': '鳳梨',
  'watermelon': '西瓜', 'melon': '甜瓜', 'cantaloupe': '洋香瓜',
  'guava': '番石榴', 'dragon fruit': '紅龍果', 'grape': '葡萄', 'mango': '芒果',
  'lychee': '荔枝', 'longan': '龍眼', 'pear': '梨', 'peach': '桃子', 'plum': '李',
  'jujube': '棗子', 'persimmon': '柿子', 'wax apple': '蓮霧',
  'sugar apple': '釋迦', 'custard apple': '釋迦', 'starfruit': '楊桃',
  'passion fruit': '百香果', 'loquat': '枇杷', 'lemon': '雜柑', 'lime': '雜柑',
  'orange': '甜橙', 'mandarin': '椪柑', 'pomelo': '柚子', 'grapefruit': '葡萄柚',
  'avocado': '酪梨', 'kiwi': '奇異果', 'strawberry': '草莓', 'cherry': '櫻桃',
  'blueberry': '藍莓', 'coconut': '椰子',

  // colloquial Chinese → MOA root
  '高麗菜': '甘藍', '結球白菜': '包心白菜', '山東白菜': '包心白菜',
  '空心菜': '蕹菜', '青江菜': '青江白菜', '地瓜葉': '甘薯葉', '番薯葉': '甘薯葉',
  '大陸妹': '萵苣菜', 'A菜': '萵苣菜', '油麥菜': '萵苣菜', '生菜': '萵苣菜',
  '芥蘭': '芥藍菜', '香菜': '芫荽', '過溝菜': '蕨菜', '過貓': '蕨菜',
  '青花菜': '花椰菜', '花菜': '花椰菜', '綠花椰': '花椰菜',
  '紅蘿蔔': '胡蘿蔔', '白蘿蔔': '蘿蔔', '菜頭': '蘿蔔',
  '地瓜': '甘薯', '番薯': '甘薯', '芋頭': '芋', '山藥': '薯蕷',
  '聖女番茄': '小番茄', '玉女番茄': '小番茄', '小番茄': '小番茄',
  '青椒': '甜椒', '四季豆': '敏豆', '長豆': '菜豆', '豇豆': '菜豆',
  '甜豌豆': '豌豆', '荷蘭豆': '豌豆',
  '大黃瓜': '胡瓜', '小黃瓜': '花胡瓜', '花胡瓜': '花胡瓜',
  '蒲瓜': '扁蒲', '瓠瓜': '扁蒲', '佛手瓜': '隼人瓜', '隼人瓜': '隼人瓜',
  '蔥': '青蔥', '青蒜': '青蔥', '蒜頭': '大蒜',
  '香菇': '濕香菇', '金針菇': '金絲菇', '木耳': '濕木耳', '黑木耳': '濕木耳',
  '豆芽': '芽菜類', '豆芽菜': '芽菜類', '綠豆芽': '芽菜類',
  '香瓜': '甜瓜', '美濃瓜': '甜瓜', '哈密瓜': '洋香瓜',
  '芭樂': '番石榴', '火龍果': '紅龍果', '檸檬': '雜柑', '金桔': '雜柑',
  '柳丁': '甜橙', '柳橙': '甜橙', '文旦': '柚子', '柚子': '柚子',
  '奇異果': '奇異果', '番荔枝': '釋迦'
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
      payload = handleWarm(params);
    } else if (action === 'backfill') {
      payload = handleBackfill(params);
    } else if (action === 'diag') {
      payload = handleDiag();
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
 *
 * Anything past `BOARD_MAX_AGE_MS` is served as-is but queues a background
 * rebuild, so the app recovers on its own if the refresh trigger stops firing.
 */
function readBoard() {
  var cache = CacheService.getScriptCache();
  var json = cache.get(BOARD_CACHE_KEY);
  if (!json) {
    json = readDurableBoard();
    if (json) cache.put(BOARD_CACHE_KEY, json, BOARD_CACHE_TTL);
  }
  if (!json) {
    // No data yet — trigger never ran. Fast, non-crawling response.
    scheduleRefresh();
    return { type: 'board', warming: true, stale: true, count: 0, items: [] };
  }

  var board = JSON.parse(json);
  board.cached = true;
  board.age_ms = boardAgeMs(board);
  board.stale = board.age_ms === null || board.age_ms > BOARD_MAX_AGE_MS;
  if (board.stale) board.refresh_queued = scheduleRefresh();
  return board;
}

/**
 * Milliseconds since the board was crawled, or null when the board predates
 * `generated_at` (which counts as stale — its real age is unknown).
 */
function boardAgeMs(board) {
  if (!board || !board.generated_at) return null;
  var built = Date.parse(board.generated_at);
  return isNaN(built) ? null : Math.max(0, Date.now() - built);
}

/**
 * Crawls the MOA API and assembles the board. Slow (many requests) — only ever
 * called from the time-driven trigger / manual setup, never from doGet.
 */
function buildBoard() {
  var dates = resolveTradeDates(true);
  if (!dates.latest) {
    return {
      type: 'board',
      error: '近期查無交易資料',
      generated_at: new Date().toISOString(),
      count: 0,
      items: []
    };
  }

  var roots = boardRoots();
  var today = fetchRootRows(roots, dates.latest);
  var prev = dates.prev ? fetchRootRows(roots, dates.prev) : {};

  var items = [];
  for (var i = 0; i < BOARD_ITEMS.length; i++) {
    var def = BOARD_ITEMS[i];
    var todayRows = selectRows(today[def.official], def);
    if (!todayRows.length) continue;
    var card = aggregateGroup(def, todayRows, selectRows(prev[def.official], def));
    if (card) items.push(card);
  }
  applyBaselines(items, readHistory(), dates.latest);

  return {
    type: 'board',
    date: rocToISO(dates.latest),
    roc_date: dates.latest,
    prev_date: dates.prev,
    // When the backend crawled, as opposed to the trading date above. The UI
    // needs both: a stuck `date` with a moving `generated_at` means 休市, while
    // a frozen `generated_at` means the refresh pipeline is broken.
    generated_at: new Date().toISOString(),
    count: items.length,
    items: items
  };
}

/** Distinct MOA root names to fetch — several board items share one root. */
function boardRoots() {
  var seen = {};
  var roots = [];
  for (var i = 0; i < BOARD_ITEMS.length; i++) {
    var root = BOARD_ITEMS[i].official;
    if (!seen[root]) {
      seen[root] = true;
      roots.push(root);
    }
  }
  return roots;
}

/** Persists a healthy board to the fast cache and to chunked durable properties. */
function storeBoard(payload) {
  var json = JSON.stringify(payload);
  CacheService.getScriptCache().put(BOARD_CACHE_KEY, json, BOARD_CACHE_TTL);
  writeChunkedProp(BOARD_PROP_PREFIX, BOARD_PROP_COUNT, json);
}

/** Reassembles the chunked durable board, or null when absent/incomplete. */
function readDurableBoard() {
  return readChunkedProp(BOARD_PROP_PREFIX, BOARD_PROP_COUNT);
}

/**
 * Writes one JSON string across numbered ScriptProperties chunks (a single
 * value caps at 9 KB), then deletes chunks left over from a larger write so
 * a shrinking payload cannot leak quota.
 */
function writeChunkedProp(prefix, countKey, json) {
  try {
    var props = PropertiesService.getScriptProperties();
    var chunks = Math.ceil(json.length / PROP_CHUNK_SIZE) || 1;
    var write = {};
    for (var i = 0; i < chunks; i++) {
      write[prefix + i] = json.substring(i * PROP_CHUNK_SIZE, (i + 1) * PROP_CHUNK_SIZE);
    }
    write[countKey] = String(chunks);
    props.setProperties(write);

    var existing = props.getProperties();
    for (var key in existing) {
      if (key.indexOf(prefix) !== 0) continue;
      var idx = parseInt(key.substring(prefix.length), 10);
      if (!isNaN(idx) && idx >= chunks) props.deleteProperty(key);
    }
  } catch (err) {
    Logger.log('writeChunkedProp error (' + prefix + '): ' + err);
  }
}

/** Reads a chunked JSON string back, or null when absent or torn. */
function readChunkedProp(prefix, countKey) {
  try {
    var all = PropertiesService.getScriptProperties().getProperties();
    var chunks = parseInt(all[countKey] || '0', 10);
    if (!chunks) return null;
    var parts = [];
    for (var i = 0; i < chunks; i++) {
      var part = all[prefix + i];
      if (part == null) return null; // torn write — treat as missing
      parts.push(part);
    }
    return parts.join('');
  } catch (err) {
    Logger.log('readChunkedProp error (' + prefix + '): ' + err);
    return null;
  }
}

/**
 * Trigger target — rebuilds and stores the board. An empty build is never
 * stored (a throttled crawl must not wipe a good board), but it is recorded so
 * `?action=diag` can show that refreshes are running and why they yield nothing.
 */
function refreshBoardCache() {
  var board = buildBoard();
  var props = PropertiesService.getScriptProperties();
  if (board.items && board.items.length) {
    storeBoard(board);
    updateHistory(board);
    props.setProperty(LAST_OK_PROP, board.generated_at + ' ' + board.roc_date + ' ' + board.count + ' items');
  } else {
    props.setProperty(LAST_FAIL_PROP, new Date().toISOString() + ' ' + (board.error || 'empty board'));
  }
  Logger.log('Board refreshed: ' + (board.count || 0) + ' items for ' + (board.roc_date || 'n/a'));
  return board;
}

/**
 * One-off trigger target used by `scheduleRefresh`. A dedicated handler name is
 * what makes spent one-off triggers safely distinguishable from the recurring
 * one, since both report a CLOCK event type.
 */
function refreshBoardCacheOnce() {
  try {
    refreshBoardCache();
  } finally {
    dropTriggers(REFRESH_ONCE_FN);
    CacheService.getScriptCache().remove(REFRESH_LOCK_KEY);
  }
}

/**
 * Queues a background rebuild without making the caller wait for the crawl,
 * which takes minutes and would blow the Web App response window.
 * @returns {boolean} true when this call queued the rebuild.
 */
function scheduleRefresh() {
  var cache = CacheService.getScriptCache();
  if (cache.get(REFRESH_LOCK_KEY)) return false; // rebuild already pending
  cache.put(REFRESH_LOCK_KEY, '1', REFRESH_LOCK_TTL);
  try {
    dropTriggers(REFRESH_ONCE_FN); // never accumulate toward the 20-trigger cap
    ScriptApp.newTrigger(REFRESH_ONCE_FN).timeBased().after(1000).create();
    return true;
  } catch (err) {
    Logger.log('scheduleRefresh error: ' + err);
    cache.remove(REFRESH_LOCK_KEY);
    return false;
  }
}

/** Deletes every project trigger bound to one handler function. */
function dropTriggers(handler) {
  var triggers = ScriptApp.getProjectTriggers();
  var dropped = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() !== handler) continue;
    ScriptApp.deleteTrigger(triggers[i]);
    dropped++;
  }
  return dropped;
}

/** `?action=warm` — queues a rebuild and answers immediately. `force=1` jumps the lock. */
function handleWarm(params) {
  if (params && params.force) CacheService.getScriptCache().remove(REFRESH_LOCK_KEY);
  var queued = scheduleRefresh();
  return {
    type: 'warm',
    queued: queued,
    message: queued ? '已排入背景更新，約一分鐘後生效' : '已有更新排程進行中',
    board: boardSummary()
  };
}

/** `?action=diag` — makes refresh liveness observable without opening the GAS console. */
function handleDiag() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  return {
    type: 'diag',
    now: new Date().toISOString(),
    board: boardSummary(),
    board_items_configured: BOARD_ITEMS.length,
    triggers: handlers,
    refresh_queued: !!CacheService.getScriptCache().get(REFRESH_LOCK_KEY),
    last_refresh_ok: props[LAST_OK_PROP] || null,
    last_refresh_fail: props[LAST_FAIL_PROP] || null,
    history: historySummary(),
  };
}

/** Freshness header of the stored board — no items, so it stays cheap to serve. */
function boardSummary() {
  var json = CacheService.getScriptCache().get(BOARD_CACHE_KEY) || readDurableBoard();
  if (!json) return null;
  var board = JSON.parse(json);
  var age = boardAgeMs(board);
  return {
    date: board.date || null,
    roc_date: board.roc_date || null,
    generated_at: board.generated_at || null,
    age_ms: age,
    stale: age === null || age > BOARD_MAX_AGE_MS,
    count: board.count || 0
  };
}
// --- Price history & baseline ---
//
// Store shape (chunked into ScriptProperties):
//   { version: 1, items: { '<display name>': [['115.08.05', 23.4], ...] } }
// Prices are 元/公斤 wholesale averages — the same measured series as the
// board's `avg_price`. Entries are keyed per BOARD ITEM, not per MOA root,
// because two items can share one root with different variety filters
// (青椒/甜椒, 玉米/玉米筍, 蔥/紅蔥頭, 白花椰菜/青花菜).

/** Parsed history store, or an empty one when absent/torn/corrupt. */
function readHistory() {
  var json = readChunkedProp(HISTORY_PROP_PREFIX, HISTORY_PROP_COUNT);
  if (json) {
    try {
      var parsed = JSON.parse(json);
      if (parsed && parsed.items) return parsed;
    } catch (err) {
      Logger.log('readHistory parse error: ' + err);
    }
  }
  return { version: 1, items: {} };
}

function writeHistory(history) {
  writeChunkedProp(HISTORY_PROP_PREFIX, HISTORY_PROP_COUNT, JSON.stringify(history));
}

/**
 * Records one (trading date, price) observation per board item. Idempotent
 * per date: the 4-hourly refresh revisits the same trading day and must
 * replace, not duplicate. Trimming rides on every write — a rolling window
 * needs no separate cleanup job that could silently die.
 */
function updateHistory(board) {
  if (!board || !board.roc_date || !board.items || !board.items.length) return;
  var history = readHistory();
  for (var i = 0; i < board.items.length; i++) {
    var it = board.items[i];
    history.items[it.name] = appendObservation(history.items[it.name], board.roc_date, it.avg_price);
  }
  pruneHistory(history);
  writeHistory(history);
}

/** Adds or replaces one dated observation, keeping the series sorted and trimmed. */
function appendObservation(series, rocDate, price) {
  var out = (series || []).filter(function (entry) { return entry[0] !== rocDate; });
  out.push([rocDate, price]);
  out.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  return out.slice(-BASELINE_WINDOW);
}

/**
 * Drops entries past the calendar horizon and whole items that left
 * BOARD_ITEMS, so the store stays bounded by construction (~50 KB worst case
 * against the 500 KB properties quota).
 */
function pruneHistory(history) {
  var cutoff = rocDateDaysAgo(BASELINE_HORIZON_DAYS);
  var known = {};
  for (var i = 0; i < BOARD_ITEMS.length; i++) known[BOARD_ITEMS[i].name] = true;
  Object.keys(history.items).forEach(function (name) {
    if (!known[name]) {
      delete history.items[name];
      return;
    }
    var kept = history.items[name].filter(function (entry) { return entry[0] >= cutoff; });
    if (kept.length) {
      history.items[name] = kept;
    } else {
      delete history.items[name];
    }
  });
}

/**
 * ROC date string `days` calendar days before today. Lexicographic comparison
 * of these strings is safe while the ROC year has 3 digits (until 2910).
 */
function rocDateDaysAgo(days) {
  var d = new Date();
  d.setDate(d.getDate() - days);
  return dateToROC(d);
}

/** Median of a non-empty numeric array. */
function median(values) {
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Attaches `baseline_price` (元/台斤) and `vs_baseline_percent` to items with
 * enough recent history. Today's own observation is excluded — the baseline
 * means "the usual price", and a spike day must not vouch for itself. Items
 * short on history simply carry no baseline fields: the frontend treats them
 * as optional, so a cold store degrades to the pre-feature UI.
 */
function applyBaselines(items, history, todayRoc) {
  var cutoff = rocDateDaysAgo(BASELINE_HORIZON_DAYS);
  for (var i = 0; i < items.length; i++) {
    var series = history.items[items[i].name] || [];
    var prices = [];
    for (var j = 0; j < series.length; j++) {
      if (series[j][0] === todayRoc || series[j][0] < cutoff) continue;
      prices.push(series[j][1]);
    }
    if (prices.length < BASELINE_MIN_DAYS) continue;
    var base = median(prices);
    if (!(base > 0)) continue;
    items[i].baseline_price = round1(base * CATTY_PER_KG);
    items[i].vs_baseline_percent = round1(((items[i].avg_price - base) / base) * 100);
  }
}

/** Cheap history overview for diag/backfill responses. */
function historySummary() {
  var history = readHistory();
  var names = Object.keys(history.items);
  var minLen = null;
  var maxLen = null;
  for (var i = 0; i < names.length; i++) {
    var len = history.items[names[i]].length;
    if (minLen === null || len < minLen) minLen = len;
    if (maxLen === null || len > maxLen) maxLen = len;
  }
  return { items: names.length, min_days: minLen, max_days: maxLen };
}

// --- History backfill (one-time seeding) ---

/**
 * `?action=backfill` — queues the historical crawl in a one-off trigger and
 * answers at once, exactly like `warm`: the crawl takes minutes and must
 * never run inside the Web App response window. `force=1` jumps the lock.
 */
function handleBackfill(params) {
  var cache = CacheService.getScriptCache();
  if (params && params.force) cache.remove(BACKFILL_LOCK_KEY);
  if (cache.get(BACKFILL_LOCK_KEY)) {
    return { type: 'backfill', queued: false, message: '已有回填排程進行中', history: historySummary() };
  }
  cache.put(BACKFILL_LOCK_KEY, '1', BACKFILL_LOCK_TTL);
  try {
    dropTriggers(BACKFILL_ONCE_FN);
    ScriptApp.newTrigger(BACKFILL_ONCE_FN).timeBased().after(1000).create();
    return { type: 'backfill', queued: true, message: '已排入背景回填，約數分鐘後生效', history: historySummary() };
  } catch (err) {
    Logger.log('handleBackfill error: ' + err);
    cache.remove(BACKFILL_LOCK_KEY);
    return { type: 'backfill', queued: false, message: String(err && err.message || err), history: historySummary() };
  }
}

/** One-off trigger target; the lock keeps repeat taps cheap for its full TTL. */
function backfillHistoryOnce() {
  try {
    backfillHistory();
  } finally {
    dropTriggers(BACKFILL_ONCE_FN);
  }
}

/**
 * Seeds the history with BACKFILL_WINDOWS × BACKFILL_WINDOW_DAYS calendar
 * days of range queries. Merging is per-date idempotent, so re-running is
 * safe and only fills gaps — a throttled window costs coverage, not
 * correctness, and the 4-hourly refresh keeps topping the window up.
 */
function backfillHistory() {
  var roots = boardRoots();
  var history = readHistory();
  var today = new Date();

  for (var w = BACKFILL_WINDOWS - 1; w >= 0; w--) {
    var end = new Date(today);
    end.setDate(today.getDate() - w * BACKFILL_WINDOW_DAYS);
    var start = new Date(end);
    start.setDate(end.getDate() - (BACKFILL_WINDOW_DAYS - 1));
    var rowsByRoot = fetchAllRows(roots, dateToROC(start), dateToROC(end));

    for (var i = 0; i < BOARD_ITEMS.length; i++) {
      var def = BOARD_ITEMS[i];
      var rows = selectRows(rowsByRoot[def.official], def);
      var byDate = {};
      for (var r = 0; r < rows.length; r++) {
        var dateKey = rows[r].TransDate;
        if (!dateKey) continue;
        (byDate[dateKey] = byDate[dateKey] || []).push(rows[r]);
      }
      Object.keys(byDate).forEach(function (roc) {
        var day = weightedAverage(byDate[roc]);
        if (day.volume < MIN_TRADE_VOLUME || !(day.avg > 0)) return;
        history.items[def.name] = appendObservation(history.items[def.name], roc, round1(day.avg));
      });
    }
  }

  pruneHistory(history);
  writeHistory(history);
  Logger.log('Backfill complete: ' + Object.keys(history.items).length + ' items with history');
  return historySummary();
}

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

// --- MOA API access ---

/**
 * Fetches all rows for a crop-name term on a ROC date, or across a closed
 * date range when `rocEnd` is given. MOA matches the term anywhere inside
 * `CropName`, so the result is a superset of the wanted root — callers must
 * filter with `selectRows` / `rowRoot`.
 */
function fetchCrop(cropName, rocStart, rocEnd) {
  if (!cropName || !rocStart) return [];
  try {
    var resp = UrlFetchApp.fetch(cropUrl(cropName, rocStart, rocEnd), { muteHttpExceptions: true });
    return parseRows(resp);
  } catch (err) {
    Logger.log('fetchCrop error (' + cropName + ' ' + rocStart + '): ' + err);
    return [];
  }
}

/** Single-date URL when `rocEnd` is omitted; a closed range otherwise. */
function cropUrl(cropName, rocStart, rocEnd) {
  return AGRICULTURE_API_URL + '?' + [
    'CropName=' + encodeURIComponent(cropName),
    'Start_time=' + encodeURIComponent(rocStart),
    'End_time=' + encodeURIComponent(rocEnd || rocStart)
  ].join('&');
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
 * Fetches rows for many root names, in small concurrent batches — on one ROC
 * date, or across a closed range when `rocEnd` is given (backfill). A single
 * 70+ request burst trips MOA's per-IP limit and comes back empty, so
 * concurrency is capped and each batch pauses briefly.
 * @returns {Object} map of root → rows[]
 */
function fetchAllRows(cropNames, rocStart, rocEnd) {
  var out = {};
  for (var start = 0; start < cropNames.length; start += FETCH_BATCH) {
    var slice = cropNames.slice(start, start + FETCH_BATCH);
    var requests = slice.map(function (name) {
      return { url: cropUrl(name, rocStart, rocEnd), muteHttpExceptions: true };
    });
    try {
      var responses = UrlFetchApp.fetchAll(requests);
      for (var i = 0; i < responses.length; i++) {
        out[slice[i]] = parseRows(responses[i]);
      }
    } catch (err) {
      Logger.log('fetchAllRows batch error (' + rocStart + '): ' + err);
    }
    if (start + FETCH_BATCH < cropNames.length) Utilities.sleep(120);
  }
  return out;
}

/**
 * Like `fetchAllRows`, but retries the roots that returned nothing once. With
 * ~100 roots a throttled batch would silently drop whole rows from the board;
 * genuinely out-of-season roots just stay empty.
 */
function fetchRootRows(roots, rocDate) {
  var out = fetchAllRows(roots, rocDate);
  var misses = roots.filter(function (r) { return !out[r] || !out[r].length; });
  if (!misses.length) return out;

  Utilities.sleep(1500);
  var retry = fetchAllRows(misses, rocDate);
  for (var i = 0; i < misses.length; i++) {
    var root = misses[i];
    if (retry[root] && retry[root].length) out[root] = retry[root];
  }
  return out;
}

/**
 * Finds the latest ROC date with real trades and the previous such date.
 * Probing costs up to 16 fetches, so the result is shared through the cache
 * for an hour — that is what keeps a burst of search misses cheap. The board
 * build passes `fresh`: its correctness must never ride on a stale probe, and
 * its fresh answer re-primes the cache for the search path.
 */
function resolveTradeDates(fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    var hit = cache.get(TRADE_DATES_CACHE_KEY);
    if (hit) return JSON.parse(hit);
  }

  var probe = '甘藍'; // cabbage: year-round, all markets, high volume — the most reliable probe
  var today = new Date();
  var latest = null;
  var prev = null;

  for (var i = 0; i < MAX_LOOKBACK_DAYS && !latest; i++) {
    var d = new Date(today);
    d.setDate(today.getDate() - i);
    var roc = dateToROC(d);
    if (isTradingDate(probe, roc)) latest = roc;
  }
  if (!latest) return { latest: null, prev: null }; // never cache a failed probe

  var latestDate = rocToDate(latest);
  for (var j = 1; j <= MAX_LOOKBACK_DAYS && !prev; j++) {
    var pd = new Date(latestDate);
    pd.setDate(latestDate.getDate() - j);
    var proc = dateToROC(pd);
    if (isTradingDate(probe, proc)) prev = proc;
  }

  var dates = { latest: latest, prev: prev };
  cache.put(TRADE_DATES_CACHE_KEY, JSON.stringify(dates), TRADE_DATES_TTL);
  return dates;
}

/**
 * True when the probe crop really traded island-wide on this date. MOA returns
 * `休市` placeholder rows with zero price/quantity for closed markets — and for
 * today, before the closing prices publish — so row count alone is not enough:
 * it would pick a date on which every board item aggregates to nothing.
 */
function isTradingDate(probe, rocDate) {
  var rows = tradedRows(fetchCrop(probe, rocDate));
  var volume = 0;
  for (var i = 0; i < rows.length; i++) {
    volume += parseFloat(rows[i].Trans_Quantity || 0);
  }
  return volume >= PROBE_MIN_VOLUME;
}

// --- Row filtering ---

/** MOA `CropName` is `<root>` or `<root>-<variety>`. */
function rowRoot(cropName) {
  if (!cropName) return '';
  var i = cropName.indexOf('-');
  return i === -1 ? cropName : cropName.substring(0, i);
}

function rowVariety(cropName) {
  if (!cropName) return '';
  var i = cropName.indexOf('-');
  return i === -1 ? '' : cropName.substring(i + 1);
}

/** Drops `休市` placeholders and any row without a real price and quantity. */
function tradedRows(rows) {
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (!r || !r.CropName || r.CropName === '休市') continue;
    if (!(parseFloat(r.Avg_Price || 0) > 0) || !(parseFloat(r.Trans_Quantity || 0) > 0)) continue;
    out.push(r);
  }
  return out;
}

/**
 * Keeps only the rows a board item actually wants: exact root match plus the
 * optional variety include/exclude. Without this, `蔥` picks up 洋蔥, `蘿蔔`
 * picks up 胡蘿蔔, `胡瓜` picks up 花胡瓜 and `薑` picks up 薑荷花.
 */
function selectRows(rows, def) {
  var out = [];
  var candidates = tradedRows(rows);
  for (var i = 0; i < candidates.length; i++) {
    var r = candidates[i];
    if (rowRoot(r.CropName) !== def.official) continue;
    var variety = rowVariety(r.CropName);
    if (def.variety && variety.indexOf(def.variety) === -1) continue;
    if (def.excludes && containsAny(variety, def.excludes)) continue;
    out.push(r);
  }
  return out;
}

function containsAny(text, needles) {
  for (var i = 0; i < needles.length; i++) {
    if (text.indexOf(needles[i]) !== -1) return true;
  }
  return false;
}

// --- Aggregation ---

/**
 * Aggregates already-filtered MOA rows into one board card.
 * Price = volume-weighted average of Avg_Price; change vs the previous date.
 */
function aggregateGroup(def, todayRows, prevRows) {
  var today = weightedAverage(todayRows);
  if (today.volume < MIN_TRADE_VOLUME || today.avg <= 0) return null;

  var changePercent = 0;
  if (prevRows && prevRows.length) {
    var prev = weightedAverage(prevRows);
    if (prev.avg > 0) {
      changePercent = ((today.avg - prev.avg) / prev.avg) * 100;
    }
  }

  var cattyPrice = today.avg * CATTY_PER_KG;
  var retail = retailBand(cattyPrice, def.official, def.category);

  return {
    code: (todayRows[0] && todayRows[0].CropCode) || def.official,
    name: def.name,
    official_name: def.official,
    category: def.category,
    avg_price: round1(today.avg),
    catty_price: round1(cattyPrice),
    retail_low: retail.low,
    retail_price: retail.mid,
    retail_high: retail.high,
    retail_estimated: true,
    change_percent: round1(changePercent),
    trade_volume: Math.round(today.volume),
    unit: '公斤',
    markets_count: today.markets
  };
}

/**
 * Estimated traditional-market retail band in 元/台斤. Rounded outward to the
 * nearest NT$5 because stalls price in round numbers, and because implying
 * single-digit precision on an estimate would be dishonest.
 */
function retailBand(cattyPrice, root, category) {
  var markup = RETAIL_MARKUP_ROOT[root];
  var low, mid, high;
  if (markup) {
    low = markup * RETAIL_BAND_LOW;
    mid = markup;
    high = markup * RETAIL_BAND_HIGH;
  } else {
    var band = RETAIL_MARKUP_CATEGORY[category] || RETAIL_MARKUP_CATEGORY['其他'];
    low = band[0];
    mid = band[1];
    high = band[2];
  }
  return {
    low: floorTo5(cattyPrice + low),
    mid: Math.round(cattyPrice + mid),
    high: ceilTo5(cattyPrice + high)
  };
}

function floorTo5(n) {
  return Math.max(5, Math.floor(n / 5) * 5);
}

function ceilTo5(n) {
  return Math.ceil(n / 5) * 5;
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

/** Best-effort category for a MOA root that is not on the board. */
function categoryOf(root) {
  for (var i = 0; i < BOARD_ITEMS.length; i++) {
    if (BOARD_ITEMS[i].official === root) return BOARD_ITEMS[i].category;
  }
  if (/菇|菌|木耳/.test(root)) return '菇類';
  if (/瓜/.test(root)) return '瓜果類';
  if (/柑|橙|柚|梨|桃|李|莓|蕉|果|棗|柿|葡萄|釋迦|蓮霧/.test(root)) return '水果';
  if (/菜|蔥|韭|芹|萵|蒿|莧/.test(root)) return '葉菜類';
  if (/薯|芋|筍|藕|蔔|蒡/.test(root)) return '根莖類';
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

// --- Setup helper: run once to install the recurring refresh trigger ---
function installDailyTrigger() {
  dropTriggers(REFRESH_CRON_FN);
  ScriptApp.newTrigger(REFRESH_CRON_FN).timeBased().everyHours(4).create();
  return refreshBoardCache();
}
