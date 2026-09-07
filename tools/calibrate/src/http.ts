/**
 * Polite, cached HTTP for the three public feeds.
 *
 * A full refit asks MOA for ~4,000 date windows. Two properties matter:
 *
 *   - **Cheap reruns.** Every response is written to `.cache/` keyed by URL, so
 *     iterating on the fit costs no traffic at all. The cache is derived data
 *     and gitignored.
 *   - **Politeness.** MOA answers a 70-request burst with empty bodies (the
 *     backend hit this in production, see `fetchAllRows`), so requests go out
 *     in small batches with a pause between them and one retry for anything
 *     that comes back empty or failed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = resolve(HERE, '../.cache');

/** Mirrors the backend's own throttle: small batches, brief pause, one retry. */
export const CONCURRENCY = 4;
export const BATCH_PAUSE_MS = 150;
export const RETRY_PAUSE_MS = 1500;
const TIMEOUT_MS = 120_000;

export type FetchStats = { requests: number; cacheHits: number; retries: number; failures: number };

export const stats: FetchStats = { requests: 0, cacheHits: 0, retries: 0, failures: 0 };

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Fetches `url` as text, through the on-disk cache.
 *
 * `accept` decides whether a body is worth caching. An empty MOA response is
 * indistinguishable from "this crop did not trade", so the caller — which
 * knows the shape — makes that call; caching a throttled empty body would
 * silently freeze a hole into every later run.
 */
export async function cachedText(
  namespace: string,
  url: string,
  accept: (body: string) => boolean,
): Promise<string> {
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 32);
  const file = resolve(CACHE_DIR, namespace, `${digest}.json`);
  if (existsSync(file)) {
    stats.cacheHits += 1;
    return readFileSync(file, 'utf8');
  }

  let body = await once(url);
  if (body === null || !accept(body)) {
    stats.retries += 1;
    await sleep(RETRY_PAUSE_MS);
    const second = await once(url);
    if (second !== null && accept(second)) body = second;
  }
  if (body === null) {
    stats.failures += 1;
    throw new Error(`fetch failed: ${url}`);
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
      headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'VeggieRadar-calibrate/1.0 (+https://github.com)' },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Runs `work` over `items` in batches of `CONCURRENCY`, pausing between
 * batches. Batches rather than a rolling window because the pause is the
 * point: it is what keeps a long refit under MOA's per-IP limit.
 */
export async function inBatches<T, R>(
  items: T[],
  work: (item: T, index: number) => Promise<R>,
  onBatch?: (done: number, total: number) => void,
): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += CONCURRENCY) {
    const slice = items.slice(start, start + CONCURRENCY);
    const results = await Promise.all(slice.map((item, i) => work(item, start + i)));
    out.push(...results);
    if (onBatch) onBatch(Math.min(start + CONCURRENCY, items.length), items.length);
    if (start + CONCURRENCY < items.length) await sleep(BATCH_PAUSE_MS);
  }
  return out;
}
