/**
 * Configuration: every tuneable constant and the board definition.
 *
 * Kept in one file because these are the knobs an operator actually turns, and
 * because Apps Script shares one global scope: a constant is visible to every
 * other file regardless of where it lives, so grouping by "what you edit"
 * beats scattering them next to their first use.
 *
 * What is deliberately NOT here is generated data: the three retail markup
 * tables (`RetailCalibration.gs`, fitted by `tools/calibrate`, README §4) and
 * the two search tables (`SearchAliases.gs`, `CropCatalog.gs`, built by
 * `tools/catalog`, README §7). A number nobody may edit by hand does not
 * belong beside the ones an operator turns.
 */

// --- Configuration ---
var AGRICULTURE_API_URL = 'https://data.moa.gov.tw/api/v1/AgriProductsTransType/';

// Operator actions. The Web App is anonymous by necessity (browsers call it),
// but `warm&force=1`, `backfill` and `alerttest` each start a crawl or a mail
// on demand — `force` alone lets anyone bypass the 15-minute lock and burn
// hundreds of UrlFetch calls per hit until the daily quota is gone and the
// board stops updating. Those actions therefore require `&token=` to match
// the ScriptProperties value under this key (set it once in the editor; it
// never enters the repo). Unset means every admin action is refused.
var ADMIN_TOKEN_PROP = 'ADMIN_TOKEN';

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

// Search serving. A miss used to cost the trading-date probe plus two live
// queries every time; the catalogue gate (§2) ends the impossible ones for
// free, and what survives it is cached per root for an hour exactly like the
// trend, so a burst of the same miss costs one crawl for everybody.
var SEARCH_CACHE_PREFIX = 'veggie_search_';

var SEARCH_CACHE_TTL = 60 * 60;  // seconds; same policy as the trend cache
var SEARCH_MAX_ROOTS = 3;        // catalogue roots one query may fan out to
var SEARCH_MAX_SUGGESTIONS = 3;  // 「試試：…」 alternatives offered on a miss
// How long a generated `CROP_CATALOG` may be trusted to REFUSE a query. The
// crawl samples 100 of the last 400 days, so a crop whose whole season falls
// between two samples can be missing, and MOA does publish new roots. Inside
// this window the gate is the feature; past it it opens and search costs what
// it always used to — a list nobody re-crawled must not become a permanent
// wall in front of a real crop. Two quarters, so the quarterly refresh
// README §7 asks for can slip once without users noticing.
var CATALOG_MAX_AGE_DAYS = 180;

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
//
// The recipient is NOT a constant: it is read from the ScriptProperties key
// below (`alertRecipient`) and must be set — a personal address has no
// business in a public repository. `diag` reports whether it is configured.
var ALERT_EMAIL_PROP = 'ALERT_EMAIL';

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

// Plausibility guard (`Validate.gs`). The refresh used to reject exactly one
// thing — an EMPTY board — so a throttled crawl or a MOA unit change would
// overwrite 94 good prices with 40 wrong ones, and `updateHistory` would bake
// the wrong numbers into the 28-day baseline on the way. Every threshold below
// answers "certainly broken", not "surprising": a rejected board means users
// keep yesterday's prices, which is itself a real cost, so the guard must never
// be what hides a thin-but-real trading day.
var BOARD_MIN_ITEMS = 30;             // absolute floor; a normal day carries ~90–94 of the 104 items defined below
// The external probe in `.github/workflows/prod-probe.yml` alerts at 60 items.
// Deliberately a different number for a different question: the probe asks
// "worth a look?", this asks "certainly broken?", and only the second one
// withholds data from users.
var BOARD_MIN_PREV_RATIO = 0.6;       // vs the stored board; seasonal drop-out is < 10 %/day, so losing 40 % is a fetch failure
var BOARD_JUMP_RATIO = 3;             // ×3 (or ÷3) in one day is not a market move
var BOARD_MAX_JUMP_SHARE = 0.2;       // ...and a fifth of the board doing it at once is a unit/column change
var BOARD_SHIFT_MIN_RATIO = 0.5;      // median ratio over common items; outside this the WHOLE board moved
var BOARD_SHIFT_MAX_RATIO = 2;
var SUSPECT_CHANGE_PERCENT = 150;     // item level; a crop can double overnight, 2.5× is a data error
var SUSPECT_VOLUME_RATIO = 0.2;       // ...and only with the volume collapsed too: one outlier trade carrying the average
var SUSPECT_VARIETY_SHARE = 95;       // a variety holding this much of the volume IS the item
var SUSPECT_VARIETY_DIVERGENCE = 0.5; // ...so a price this far from the blend means the rows were grouped wrong
// The rejected board is kept rather than dropped: it is the only evidence of
// what MOA actually answered. Chunked like the live board — a single property
// caps at 9 KB and a board is ~40 KB.
var REJECTED_PROP_PREFIX = 'veggie_board_rejected_chunk_';
var REJECTED_PROP_COUNT = 'veggie_board_rejected_chunks';
var LAST_VALIDATION_PROP = 'veggie_last_validation'; // last verdict, published by `diag`

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
 * Band width applied to a per-root markup, which is a midpoint only. Not
 * fitted — the shape of the band, not data — so it stays with the knobs while
 * `RetailCalibration.gs` holds the fitted numbers.
 */
var RETAIL_BAND_LOW = 0.75;

var RETAIL_BAND_HIGH = 1.35;
