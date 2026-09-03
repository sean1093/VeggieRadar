/**
 * Configuration: every tuneable constant, the board definition, the
 * calibrated retail markups and the search alias table.
 *
 * Kept in one file because these are the knobs an operator actually turns, and
 * because Apps Script shares one global scope: a constant is visible to every
 * other file regardless of where it lives, so grouping by "what you edit"
 * beats scattering them next to their first use.
 */

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
// Variety breakdown shown in the item drawer. Only varieties that matter are
// published: at least two of them, each holding a meaningful slice of the
// item's traded volume — otherwise the blended average already tells the story.
var VARIETY_MIN_SHARE = 0.1;   // of the item's total traded volume
var VARIETY_MAX_COUNT = 4;     // by volume; keeps the drawer calm
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
// board is ~34 KB, so it is written as numbered chunks.
var BOARD_PROP_PREFIX = 'veggie_board_v2_chunk_';

var BOARD_PROP_COUNT = 'veggie_board_v2_chunks';

var PROP_CHUNK_SIZE = 8000;

// Freshness. `date`/`roc_date` is the trading date of the prices — it legitimately
// stays put over weekends, holidays and typhoon closures, when MOA publishes only
// `休市` rows. `generated_at` is when we last crawled, which must keep moving; a
// board that stops being regenerated is the actual failure mode.
//
// BOARD_MAX_AGE_MS must stay comfortably ABOVE the refresh cadence plus the
// crawl duration. When the two were both 4 h, a perfectly healthy board spent
// the minutes before every scheduled run reporting `stale: true` — which
// queued a pointless rebuild and showed 「資料更新中」 to whoever loaded the
// app in that window. The threshold answers "is the pipeline dead?", so it
// only has to be tight enough to self-heal within one visit.
var REFRESH_INTERVAL_HOURS = 4;                  // time-driven trigger cadence
var BOARD_MAX_AGE_MS = 6 * 60 * 60 * 1000;       // > cadence + crawl; rebuild on demand past this
var REFRESH_LOCK_KEY = 'veggie_refresh_queued';

var REFRESH_LOCK_TTL = 15 * 60;            // seconds; one queued rebuild per window
var REFRESH_ONCE_FN = 'refreshBoardCacheOnce';

var REFRESH_CRON_FN = 'refreshBoardCache';

var LAST_OK_PROP = 'veggie_last_refresh_ok';

var LAST_FAIL_PROP = 'veggie_last_refresh_fail';

// Failure alerting. A single failed refresh is routine (MOA throttles a batch
// now and then) and self-heals, so alerting on one would train the recipient
// to ignore the mail. Two distinct real failures deserve an email:
//   - a STREAK of failed refreshes: the crawl runs but never yields a board.
//   - SILENCE: the board keeps ageing with no refresh at all, which is what a
//     deleted or broken trigger looks like. Nothing is running to notice it,
//     so the serving path raises this one.
// Both are rate-limited to one mail per incident window, and every mail path
// is wrapped so alerting can never break serving or a refresh.
// Because every one of those decisions is a read-modify-write on shared
// state, they all run inside one script-lock section — see `withAlertLock`.
var ALERT_EMAIL = 'sean1093@gmail.com';

var ALERT_FAILURE_STREAK = 3;                      // consecutive failed refreshes ≈ half a day stale
var ALERT_SILENCE_MS = 12 * 60 * 60 * 1000;        // board age that means nothing is running
var ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;       // one alert per incident window
var ALERT_LOCK_WAIT_MS = 3 * 1000;                 // brief: losing the race means someone else is deciding
var ALERT_TEST_PROP = 'veggie_alert_test_at';      // durable, so cache eviction cannot re-open the endpoint
var ALERT_TEST_INTERVAL_MS = 60 * 60 * 1000;       // bounds a SUCCESSFUL ?action=alerttest
var ALERT_TEST_FAIL_PROP = 'veggie_alert_test_failed_at';

var ALERT_TEST_FAIL_BACKOFF_MS = 60 * 1000;        // bounds hammering a broken channel
var ALERT_STREAK_PROP = 'veggie_alert_streak';

var ALERT_SENT_PROP = 'veggie_alert_sent_at';

var ALERT_ACTIVE_PROP = 'veggie_alert_active';

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
var HISTORY_LOCK_WAIT_MS = 30 * 1000; // serialises history writes across overlapping triggers
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
