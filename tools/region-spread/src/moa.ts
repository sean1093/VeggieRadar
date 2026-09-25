/**
 * Fetching the window of MOA rows the measurement runs on, with the two
 * defences the feed demands.
 *
 * **Truncation.** MOA caps one response near 1,000 rows and says so with
 * `Next: true`, keeping the newest rows and dropping the oldest. A silently
 * truncated window would delete the start of the period from the sample — and
 * because markets are dropped oldest-first rather than at random, it would bias
 * exactly the day-over-day comparison this tool is here to judge. Any window
 * that reports `Next` is halved and refetched, down to a single day.
 *
 * **Throttling.** MOA answers a wide burst with empty bodies rather than an
 * error (the backend hit this in production, see `fetchAllRows`), which is
 * indistinguishable from "this crop did not trade". Requests therefore go out
 * in small batches with a pause, an empty body is retried once, and the cache
 * only keeps a settled answer.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackend } from './backend.ts';
import type { MoaRow } from './backend.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Where responses are cached — the gitignored `.cache/` beside the tool, or
 * wherever `REGION_SPREAD_CACHE_DIR` points. The override exists so a test can
 * work in a temporary directory: what may be written here is the whole subject
 * of `cachedText` below, and it must be provable without touching a
 * developer's real cache.
 */
export const CACHE_DIR = process.env.REGION_SPREAD_CACHE_DIR
  ? resolve(process.env.REGION_SPREAD_CACHE_DIR)
  : resolve(HERE, '../.cache');

/** Mirrors the backend's own throttle. */
const CONCURRENCY = 4;
const BATCH_PAUSE_MS = 150;
export const RETRY_PAUSE_MS = 1_500;
const TIMEOUT_MS = 120_000;

export type DateRange = { from: string; to: string };
export type FetchStats = { requests: number; cacheHits: number; retries: number; failures: number };

export const stats: FetchStats = { requests: 0, cacheHits: 0, retries: 0, failures: 0 };

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** ISO date arithmetic in UTC: these are calendar dates, never instants. */
export function addDays(iso: string, days: number): string {
  const at = new Date(`${iso}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Inclusive length of a closed date range, in calendar days. */
export function spanDays(range: DateRange): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

/** `[from, to]` split into consecutive closed windows of at most `days`. */
export function windows(from: string, to: string, days: number): DateRange[] {
  const out: DateRange[] = [];
  for (let start = from; start <= to; start = addDays(start, days)) {
    const end = addDays(start, days - 1);
    out.push({ from: start, to: end < to ? end : to });
  }
  return out;
}

/** ROC date string for the API, via the backend's own converter. */
function roc(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return loadBackend().dateToROC(new Date(year, month - 1, day));
}

/** Every MOA row for one root across `[from, to]`. */
export async function fetchRoot(root: string, from: string, to: string): Promise<MoaRow[]> {
  const backend = loadBackend();
  const pending = windows(from, to, backend.BACKFILL_WINDOW_DAYS);
  const rows: MoaRow[] = [];

  while (pending.length) {
    const batch = pending.splice(0, pending.length);
    const results = await inBatches(batch, async (window) => {
      const url = backend.cropUrl(root, roc(window.from), roc(window.to));
      const body = await cachedText(url);
      return { window, payload: JSON.parse(body) as { Data?: MoaRow[]; Next?: boolean } };
    });
    for (const { window, payload } of results) {
      const span = spanDays(window);
      if (payload.Next === true && span > 1) {
        const half = Math.ceil(span / 2);
        pending.push({ from: window.from, to: addDays(window.from, half - 1) });
        pending.push({ from: addDays(window.from, half), to: window.to });
        continue;
      }
      rows.push(...(payload.Data ?? []));
    }
  }
  return rows;
}

/**
 * A settled MOA answer, told apart from a throttled one by the `RS` envelope
 * key the feed wraps every real response in — including a real "this crop did
 * not trade", which is an empty `Data` rather than an empty body.
 */
function usableBody(body: string | null): body is string {
  return body !== null && body.includes('"RS"');
}

/**
 * Fetches `url` as text through the on-disk cache.
 *
 * Only a settled body may be cached OR returned. `.cache/` is keyed by URL with
 * no expiry, so a throttled empty response stored once is read back by every
 * later run until someone deletes the directory by hand — `tools/calibrate`
 * shipped exactly that bug (#69) and its fix is mirrored here. For this tool
 * the stake is higher than a wasted run: an empty day for one root is a day
 * whose regional split silently loses whichever markets that request covered,
 * which is a fabricated regional price move rather than a visible failure.
 *
 * The two failures are distinguished because they are acted on differently:
 * one is the network, the other is the feed throttling us.
 */
async function cachedText(url: string): Promise<string> {
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 32);
  const file = resolve(CACHE_DIR, `${digest}.json`);
  if (existsSync(file)) {
    stats.cacheHits += 1;
    return readFileSync(file, 'utf8');
  }

  let body = await once(url);
  if (!usableBody(body)) {
    stats.retries += 1;
    await sleep(RETRY_PAUSE_MS);
    // The retry's outcome replaces the first attempt's outright, so the error
    // below describes the attempt it is reporting on.
    body = await once(url);
  }
  if (!usableBody(body)) {
    stats.failures += 1;
    throw new Error(body === null ? `fetch failed: ${url}` : `unusable response: ${url}`);
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return body;
}

async function once(url: string): Promise<string | null> {
  stats.requests += 1;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Accept-Encoding': 'gzip',
        'User-Agent': 'VeggieRadar-region-spread/1.0 (+https://github.com/sean1093/VeggieRadar)',
      },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** Runs `work` over `items` in batches, pausing between them — the pause is the point. */
async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += CONCURRENCY) {
    const slice = items.slice(start, start + CONCURRENCY);
    out.push(...(await Promise.all(slice.map(work))));
    if (start + CONCURRENCY < items.length) await sleep(BATCH_PAUSE_MS);
  }
  return out;
}
