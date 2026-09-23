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
var PROBE_ROOT = '甘藍';         // cabbage: year-round, all markets, high volume — the most reliable probe
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
var TREND_UNANSWERED_TTL = 2 * 60; // seconds; see `handleTrend`
// MOA caps one response near 1000 rows. 14 days of most crops stays under it;
// when a broad term does not, `handleTrend` leaves the cut oldest point out.
var TREND_MAX_DAYS = 14;
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

// Why the last alert mail did not go out, as a `classifyMailError` CATEGORY —
// never the raw text, which can quote the recipient address. Opening an
// incident no longer depends on being able to send one (an unset ALERT_EMAIL
// used to leave the backend knowing it was broken and telling nobody, `diag`
// included), so this is what says the mailbox is silent on purpose.
var ALERT_UNSENT_PROP = 'veggie_alert_unsent_reason';

// Mirror deploys (#68). The published mirror is only as fresh as the last
// Pages deploy, and asking a cron for one is not the same as getting one: over
// 222 h a `20 */2 * * *` schedule produced a median gap of 4.5 h, and hourly
// over the next 137 h produced 4.64 h — the ticks are throttled, not dropped.
// `repository_dispatch` is API-triggered and not throttled that way, so the
// backend asks for the deploy itself once a crawl lands.
//
// The token is a fine-grained PAT scoped to this repository with
// `contents: write`, kept in Script Properties like every other secret. Unset,
// the whole thing is skipped and the schedule remains the fallback.
var GH_DISPATCH_TOKEN_PROP = 'GH_DISPATCH_TOKEN';
var GH_DISPATCH_EVENT = 'board-crawled';
var GH_DISPATCH_URL = 'https://api.github.com/repos/sean1093/VeggieRadar/dispatches';
// The last attempt, as "<ISO> <outcome>": what `diag` reports, including the
// throttled ones, since those are the crawls the mirror does not carry.
var GH_DISPATCH_PROP = 'veggie_mirror_dispatch';
// The last ACCEPTED dispatch, which is the only kind that costs a Pages
// deploy, and so the only kind that arms the floor below. Separate from the
// record above on purpose: writing every attempt into the floor's own clock
// would let a rejected attempt suppress the retry that recovers from it, and
// a throttled one extend the floor for as long as something kept crawling.
var GH_DISPATCH_OK_PROP = 'veggie_mirror_dispatch_ok';
// `?action=warm` is public and releases its lock when the crawl ends, so a
// visitor can drive crawls every few minutes; a Pages deploy is a minute of CI
// against a soft limit of ten an hour. A crawl inside this window is not
// mirrored until the next one, and its board differs from the mirrored one by
// less than the window.
var GH_DISPATCH_MIN_INTERVAL_MS = 30 * 60 * 1000;
// The other half of that floor. A rejection costs no deploy, so the next crawl
// must be free to retry it — but an expired PAT beside a public `?action=warm`
// would otherwise POST a doomed request every few minutes for as long as
// anyone kept crawling, and get the token secondary-rate-limited for it.
var GH_DISPATCH_FAIL_BACKOFF_MS = 5 * 60 * 1000;

// Long-term price history in a Google Sheet (`SheetHistory.gs`, #22). The
// ScriptProperties history is a rolling 28 trading days by design — 500 KB is
// what it gets — so 「比去年同期」 and a per-variety baseline need somewhere
// else to be measured from. The spreadsheet is the deployer's own, named by
// this property; unset, the whole thing is off and nothing changes.
var HISTORY_SHEET_ID_PROP = 'HISTORY_SHEET_ID';
// The last trading day archived, as "<ISO date> <generated_at>". The date says
// whether that day is already written; the timestamp bounds how often a
// revisit is worth looking at, which is all the clock decides — what replaces
// a day is the rows differing (`archiveDay`).
var SHEET_LAST_WRITE_PROP = 'veggie_sheet_last_write';
// How often a crawl of the SAME trading day is worth comparing against what
// was archived. MOA completes a day's closing prices through the evening, so
// a later crawl can carry better numbers; inside this window it is the
// 4-hourly refresh revisiting the same day, and is skipped without a read.
var SHEET_CORRECTION_MS = 6 * 60 * 60 * 1000;

// Backfilling the archive from MOA (#22 §4). A year is ~40 range windows and
// one Apps Script execution stops at 6 minutes, so the backfill is a chain of
// one-off triggers, one window each, walking backwards from the day before the
// board's trading date. The job — its reach, where it has got to and what it
// wrote — lives in one property, which is what lets a chain that died (a
// quota, a deploy, a trigger that never fired) be resumed rather than redone.
var SHEET_BACKFILL_FN = 'sheetBackfillStep';
var SHEET_BACKFILL_PROP = 'veggie_sheet_backfill';
// The id of a job the operator cancelled. Its own property, because the chain
// rewrites the job as it goes and could write "running" straight back over a
// cancel that landed between its read and its write; nothing but a cancel
// ever writes this one.
var SHEET_BACKFILL_CANCEL_PROP = 'veggie_sheet_backfill_cancel';
// Leading days fetched only to be the PREVIOUS trading day of the first day
// written: `validateBoard`'s rule (e) judges a day against the one before it,
// and without them the first day of every window would go unjudged. Taken out
// of the same `BACKFILL_WINDOW_DAYS` request, which is what keeps it under
// MOA's row cap: each link writes the other 9. A closure longer than this
// (春節 runs 4–6 days) is handled by deferring that first day to the next
// window, where it is the newest day and has the whole window behind it.
var SHEET_BACKFILL_CONTEXT_DAYS = 3;
var SHEET_BACKFILL_DEFAULT_MONTHS = 12;
var SHEET_BACKFILL_MAX_MONTHS = 24;
// Consecutive failed windows before the chain stops itself. A window that
// failed is retried by the next link, but one that keeps failing — a revoked
// share, a spent quota, a window too slow for the 6-minute limit — must not
// loop a crawl every few seconds for ever.
var SHEET_BACKFILL_MAX_FAILURES = 3;
// A running job that has not moved for this long has no chain behind it: one
// link runs for at most 6 minutes and queues the next within minutes.
var SHEET_BACKFILL_STALL_MS = 15 * 60 * 1000;
// How long a link can possibly still be running: the execution limit, plus a
// margin. A job whose last link started longer ago than this has nothing in
// flight that could still write it back.
var SHEET_BACKFILL_LINK_MAX_MS = 7 * 60 * 1000;
// The wait before retrying a failed window, times the failures so far. A
// per-IP throttle lasts minutes; retrying after a second would spend every
// retry inside it and stop the job over something that clears on its own.
// Kept well under the stall window, which it must not look like.
var SHEET_BACKFILL_RETRY_MS = 3 * 60 * 1000;
// A window MOA keeps answering the same way is not retried for ever. Up to
// this many roots refused every time — the probe never among them — is a
// refusal of those crops, and the window is written without them, on record.
// More is a throttle, which drops a whole batch and clears on its own, and
// keeps failing the window instead.
var SHEET_BACKFILL_MAX_REFUSED = 2;
// How many times MOA must answer a window the same way before that answer is
// acted on (a gap, or a window written without a refused crop). Its own knob:
// tolerating flakier links must not also mean crawling a hole more times.
var SHEET_BACKFILL_SETTLE_ANSWERS = 3;
// Days a job moved past without writing, kept so coverage can leave them out.
// Past this the job stops claiming coverage (`addHoles`), rather than forget.
var SHEET_BACKFILL_MAX_HOLES = 40;
// The dates a year tab already holds, cached for the length of a job: its
// range never meets a date the live path writes, so after the first read the
// only dates that can appear in it are its own, which it adds as it goes.
var SHEET_PRESENT_CACHE_PREFIX = 'veggie_sheet_present_';
var SHEET_PRESENT_CACHE_TTL = 6 * 60 * 60; // seconds; the platform maximum
var SHEET_FROZEN_CACHE_PREFIX = 'veggie_sheet_frozen_';

// 「比去年同期」 (#22 §2): each item against its own price in the same weeks a
// year earlier, from the archive. The median over the trading days within
// this many calendar days either side of the date a year back — a window, not
// the one day, because a single day a year ago is one market's weather.
var YOY_WINDOW_DAYS = 7;
var YOY_MIN_SIDE_DAYS = 2;       // archived days needed on EACH side of the day; fewer → nothing published
// Computed once per trading date and kept here, so a refresh reads the Sheet
// once a day rather than every four hours: "<roc date>" plus the medians.
var YOY_PROP = 'veggie_yoy';
// How long a read is good for. A day, normally — and a long closure keeps one
// trading date for days, so this, not the date, is what makes it read again.
// Six hours while a backfill is running, which may be adding to the window.
var YOY_KEEP_MS = 24 * 60 * 60 * 1000;
var YOY_SOON_MS = 6 * 60 * 60 * 1000; // …while a backfill may add to the window, or the tab needs re-sorting
// Kept medians older than this many days are not applied at all: the window
// they describe has moved too far from the board's date.
var YOY_KEPT_MAX_DAYS = 7;
// Runs of the window's rows past which the tab is taken as sorted by another
// column: the backfill writes a week in at most a few runs.
var YOY_MAX_RUNS = 20;
// Rows of other days that may sit between runs read in one call.
var YOY_MERGE_SLACK_ROWS = 400;
// The year-ago read is the refresh's last step; past this far into the run it
// is left to the next refresh, well inside the 6-minute execution limit.
var YOY_START_BY_MS = 4 * 60 * 1000;
var YOY_SKIPPED_PROP = 'veggie_yoy_skipped_at'; // when a read was last left for time
// The archive's readers wait this long for the history lock, not the 30 s a
// write does: their read is optional — a busy lock costs a comparison until
// the next refresh — and two of them run back to back at the end of one.
var READER_LOCK_WAIT_MS = 5 * 1000;
var ISO_DAY = /^\d{4}-\d{2}-\d{2}$/; // what a date cell in the archive reads as

// Per-variety baselines (#22 §3): each variety's own 28-trading-day median,
// read from the archive's variety rows the way the item baseline reads the
// rolling history — `BASELINE_WINDOW` days within `BASELINE_HORIZON_DAYS`,
// `BASELINE_MIN_DAYS` of them at least. Chunked: ~100 items with up to four
// varieties each is more than one 9 KB property holds.
var VARIETY_BASE_PREFIX = 'veggie_variety_base_chunk_';
var VARIETY_BASE_COUNT = 'veggie_variety_base_chunks';
// A read left undone — for time, or because it failed — as JSON with its
// sheet, for `diag`; cleared by the next read that happens.
var VARIETY_BASE_SKIPPED_PROP = 'veggie_variety_base_skipped_at';
// What the archive holds, as the status request reports it. Counting it reads
// column A of every year tab, and an operator watching a job polls.
var SHEET_SUMMARY_CACHE_KEY = 'veggie_sheet_summary';
var SHEET_SUMMARY_CACHE_TTL = 10 * 60; // seconds

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
