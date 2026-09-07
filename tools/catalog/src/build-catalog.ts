/**
 * Generates `backend/CropCatalog.gs`: every MOA root crop name that really
 * traded recently.
 *
 * That list is the search gate. A query matching no root cannot exist in the
 * feed, so `handleSearch` answers it in milliseconds instead of probing trading
 * dates and running two live queries for a crop MOA has never published.
 *
 * **Why the crawl walks day × market.** `?Start_time=&End_time=` without
 * `CropName` does work, but the response caps near 1000 rows and the `Page`
 * parameter is ignored, so a whole day is simply unreachable. Adding
 * `MarketName=` brings one day-market slice to ~300 rows with `Next: false` —
 * a complete slice. Hence sampled days × markets: 100 × 14 ≈ 1400 slices, and
 * a closed market answers empty and is retried once, so ~1800 requests.
 *
 * **Why a 4-day stride and not 7.** Wholesale markets rest on fixed weekdays;
 * a 7-day stride samples one weekday for the entire window and would report
 * every market that rests on it as permanently closed. 4 divides the window
 * evenly across all seven weekdays, and 100 sampled days is what catches a
 * crop whose whole season is three weeks long (龍眼, 枇杷).
 *
 * **Why a committed last-seen index.** The crawl window is 400 days, so
 * "unseen for 24 months" can only mean something across runs. Each run merges
 * `last-seen.json` (root → the last month it traded), which is what lets a
 * quarterly refresh retire a root that MOA stopped publishing two years ago
 * instead of carrying it forever.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { renderCropCatalog } from './render.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const BACKEND = resolve(REPO, 'backend');
const CACHE_DIR = resolve(HERE, '../.cache');
const SEEN_PATH = resolve(HERE, '../last-seen.json');

const API = 'https://data.moa.gov.tw/api/v1/AgriProductsTransType/';
const WINDOW_DAYS = 400;
const STRIDE_DAYS = 4;
const KEEP_MONTHS = 24;
const CONCURRENCY = 4; // MOA throttles per IP; a wider burst comes back empty
const PAUSE_MS = 150;
const REQUEST_TIMEOUT_MS = 90_000;
/** Year-round, island-wide, high volume — the same probe the backend trusts. */
const PROBE_CROP = '甘藍';
/**
 * The feed's transaction types: `N04` vegetables, `N05` fruit, `N06` cut
 * flowers. Flowers are more than half of every day's rows and are excluded —
 * this is a produce board, and letting 「火鶴花」 through the gate would answer
 * it with a per-catty price and a retail band fitted on vegetables, which
 * would be a lie rather than a limitation. Both board categories map onto
 * exactly these two types.
 */
const PRODUCE_TYPES = ['N04', 'N05'];

interface MoaRow {
  CropName?: string;
  MarketName?: string;
  TransDate?: string;
  TcType?: string;
  Avg_Price?: number;
  Trans_Quantity?: number;
}

interface MoaHelpers {
  rowRoot: (cropName: string) => string;
  tradedRows: (rows: MoaRow[]) => MoaRow[];
  dateToROC: (d: Date) => string;
}

/**
 * The row filters come from the backend itself: `rowRoot` splits
 * `<root>-<variety>` and `tradedRows` drops the `休市` placeholders closed
 * markets return. Re-implementing either here is how the catalogue would end
 * up disagreeing with the board it gates.
 */
const moa = new Function(
  `${readFileSync(resolve(BACKEND, 'Moa.gs'), 'utf8')}
   return { rowRoot: rowRoot, tradedRows: tradedRows, dateToROC: dateToROC };`,
)() as MoaHelpers;

/**
 * The board definition, read from the source that drives the daily refresh, so
 * a board root can never be missing from the catalogue that gates search.
 */
const BOARD_DEFS = new Function(
  `${readFileSync(resolve(BACKEND, 'Config.gs'), 'utf8')}\nreturn BOARD_ITEMS;`,
)() as { official: string }[];

async function request(params: Record<string, string>): Promise<MoaRow[]> {
  const url = `${API}?${new URLSearchParams(params).toString()}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return [];
    const body = (await res.json()) as { Data?: MoaRow[] };
    return body.Data ?? [];
  } catch {
    return [];
  }
}

/**
 * One day-market slice, cached on disk. A throttled slice comes back as an
 * empty `Data` array rather than an error, so an empty answer is retried once —
 * and the settled outcome is cached, empty or not, so a re-run costs nothing.
 */
async function slice(market: string, roc: string): Promise<MoaRow[]> {
  const file = resolve(CACHE_DIR, `${roc}_${market}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as MoaRow[];

  let rows = await request({ Start_time: roc, End_time: roc, MarketName: market });
  if (!rows.length) {
    await sleep(1_000);
    rows = await request({ Start_time: roc, End_time: roc, MarketName: market });
  }
  writeFileSync(file, JSON.stringify(rows));
  return rows;
}

/** ROC `115.09.02` → `2026-09`, the granularity the retirement rule needs. */
function monthOf(rocDate: string): string {
  const [year, month] = rocDate.split('.');
  return `${parseInt(year, 10) + 1911}-${month}`;
}

function monthsAgo(count: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - count);
  return `${d.getFullYear()}-${`0${d.getMonth() + 1}`.slice(-2)}`;
}

/** Latest date on which the probe crop really traded — where sampling starts. */
async function latestTradingDay(): Promise<string> {
  for (let back = 0; back < 10; back++) {
    const d = new Date();
    d.setDate(d.getDate() - back);
    const roc = moa.dateToROC(d);
    if (moa.tradedRows(await request({ CropName: PROBE_CROP, Start_time: roc, End_time: roc })).length) {
      return roc;
    }
  }
  throw new Error('MOA published no trading day in the last 10 days — is the feed up?');
}

/**
 * The market list. A full-day query is truncated by the 1000-row cap and so
 * finds only the busiest few markets; the probe crop trades everywhere and
 * fills in the rest. The union is the crawl's second dimension.
 */
async function discoverMarkets(roc: string): Promise<string[]> {
  const [day, probe] = await Promise.all([
    request({ Start_time: roc, End_time: roc }),
    request({ CropName: PROBE_CROP, Start_time: roc, End_time: roc }),
  ]);
  const names = new Set<string>();
  for (const r of [...day, ...probe]) if (r.MarketName) names.add(r.MarketName);
  return [...names].sort();
}

/** Runs `work` over `jobs` with a bounded number in flight. */
async function inWaves<T>(jobs: T[], run: (job: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < jobs.length; start += CONCURRENCY) {
    await Promise.all(jobs.slice(start, start + CONCURRENCY).map(run));
    if (start + CONCURRENCY < jobs.length) await sleep(PAUSE_MS);
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  mkdirSync(CACHE_DIR, { recursive: true });

  const from = await latestTradingDay();
  const markets = await discoverMarkets(from);
  const anchor = new Date(
    parseInt(from.split('.')[0], 10) + 1911,
    parseInt(from.split('.')[1], 10) - 1,
    parseInt(from.split('.')[2], 10),
  );
  const days: string[] = [];
  for (let back = 0; back < WINDOW_DAYS; back += STRIDE_DAYS) {
    const d = new Date(anchor);
    d.setDate(anchor.getDate() - back);
    days.push(moa.dateToROC(d));
  }
  console.log(`crawling ${days.length} days × ${markets.length} markets (${markets.join(' ')})`);

  const seen: Record<string, string> = existsSync(SEEN_PATH)
    ? (JSON.parse(readFileSync(SEEN_PATH, 'utf8')) as Record<string, string>)
    : {};
  const carried = Object.keys(seen).length;
  let requests = 0;
  let rows = 0;
  let done = 0;

  const jobs = days.flatMap((roc) => markets.map((market) => ({ roc, market })));
  await inWaves(jobs, async ({ roc, market }) => {
    const cached = existsSync(resolve(CACHE_DIR, `${roc}_${market}.json`));
    const slices = moa.tradedRows(await slice(market, roc));
    if (!cached) requests += slices.length ? 1 : 2; // an empty slice was retried once
    for (const r of slices) {
      if (PRODUCE_TYPES.indexOf(r.TcType ?? '') === -1) continue;
      rows++;
      const root = moa.rowRoot(r.CropName ?? '');
      if (!root) continue;
      const month = monthOf(r.TransDate ?? roc);
      if (!seen[root] || seen[root] < month) seen[root] = month;
    }
    if (++done % 50 === 0) console.log(`  ${done}/${jobs.length} slices, ${Object.keys(seen).length} roots`);
  });

  const cutoff = monthsAgo(KEEP_MONTHS);
  const kept: Record<string, string> = {};
  for (const root of Object.keys(seen).sort()) if (seen[root] >= cutoff) kept[root] = seen[root];
  writeFileSync(SEEN_PATH, `${JSON.stringify(kept, null, 2)}\n`);

  // Board roots are catalogue members by construction: the daily refresh
  // already crawls them, so one whose 3-week season fell between two samples
  // must not be gated out of search.
  const roots = [...new Set([...Object.keys(kept), ...BOARD_DEFS.map((d) => d.official)])].sort();
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(resolve(BACKEND, 'CropCatalog.gs'), renderCropCatalog(roots, { date, months: KEEP_MONTHS }));

  const dropped = Object.keys(seen).length - Object.keys(kept).length;
  console.log(
    `CropCatalog.gs: ${roots.length} roots (${Object.keys(kept).length} crawled or carried, ` +
      `${carried} carried in, ${dropped} retired) from ${rows} traded rows, ` +
      `${requests} requests, ${Math.round((Date.now() - started) / 1000)}s`,
  );
}

await main();
