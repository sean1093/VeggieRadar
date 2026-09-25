/**
 * The two defences the MOA fetch layer exists for.
 *
 * **What may be written into `.cache/`.** The cache is why fixing the region
 * table and re-running costs no traffic, and it is also the one place a bad
 * response can outlive the run that fetched it: MOA answers a burst with empty
 * bodies, and `.cache/` is keyed by URL with no expiry. A throttled body stored
 * once would be read back by every later run until someone deleted the
 * directory by hand — and here that does not surface as a failure but as a day
 * whose regional split quietly lost some markets, which is indistinguishable
 * from a real regional price move. `tools/calibrate` shipped this bug (#69).
 *
 * **Truncation.** MOA caps a response near 1,000 rows and flags it with
 * `Next: true`, dropping the OLDEST rows. Accepting a truncated window would
 * delete the start of the period — and because the drop is oldest-first rather
 * than random, it biases exactly the day-over-day comparison the tool judges.
 *
 * `fetch` is stubbed and `REGION_SPREAD_CACHE_DIR` points at a temporary
 * directory: nothing here touches the network or a developer's real cache.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CACHE = mkdtempSync(join(tmpdir(), 'region-spread-cache-'));
process.env.REGION_SPREAD_CACHE_DIR = CACHE;

// Imported after the variable is set: `CACHE_DIR` is resolved once, at import.
const { fetchRoot, stats, windows, addDays, spanDays, CACHE_DIR, RETRY_PAUSE_MS } =
  await import('../src/moa.ts');

afterAll(() => rmSync(CACHE, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(CACHE_DIR, { recursive: true, force: true });
  Object.assign(stats, { requests: 0, cacheHits: 0, retries: 0, failures: 0 });
  stats.truncated.clear();
});

/** Everything the cache holds, so "nothing was written" is a real assertion. */
const cached = (): string[] => {
  try {
    return readdirSync(CACHE_DIR);
  } catch {
    return []; // the directory is only created by a write
  }
};

/** One stubbed response per call, in order; the last repeats. `null` fails the request. */
function serve(...bodies: (string | null)[]): () => number {
  let call = 0;
  vi.stubGlobal('fetch', async () => {
    const body = bodies[Math.min(call++, bodies.length - 1)];
    if (body === null) return { ok: false, text: async () => '' };
    return { ok: true, text: async () => body };
  });
  return () => call;
}

const answer = (rows: unknown[], next = false) => JSON.stringify({ RS: 'ok', Next: next, Data: rows });
const row = (TransDate: string) => ({ TransDate, CropName: '甘藍', MarketName: '台北一', Avg_Price: 20, Trans_Quantity: 900 });

/** Runs `work`, letting the retry pause elapse without waiting 1.5 s for it. */
async function withoutThePause<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const running = work();
    // Claimed before the clock moves: a rejection landing while the timers are
    // advanced is unhandled at that moment, which vitest exits non-zero on with
    // every test still reported as passing. It is awaited for real below.
    running.catch(() => {});
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS * 2);
    return await running;
  } finally {
    vi.useRealTimers();
  }
}

describe('the cache', () => {
  it('stores a settled answer and serves the next run from it', async () => {
    const calls = serve(answer([row('115.09.01')]));
    expect(await fetchRoot('甘藍', '2026-09-01', '2026-09-01')).toHaveLength(1);
    expect(cached()).toHaveLength(1);

    expect(await fetchRoot('甘藍', '2026-09-01', '2026-09-01')).toHaveLength(1);
    expect(calls()).toBe(1); // the second run never reached the network
    expect(stats.cacheHits).toBe(1);
  });

  it('caches a real "did not trade", which is an empty Data and not an empty body', async () => {
    serve(answer([]));
    expect(await fetchRoot('蘆筍', '2026-09-01', '2026-09-01')).toEqual([]);
    expect(cached()).toHaveLength(1);
    expect(stats.failures).toBe(0);
  });

  it('retries a throttled body once, and keeps the answer the retry brought', async () => {
    const calls = serve('', answer([row('115.09.01')]));
    expect(await withoutThePause(() => fetchRoot('甘藍', '2026-09-01', '2026-09-01'))).toHaveLength(1);
    expect(calls()).toBe(2);
    expect(stats.retries).toBe(1);
    expect(stats.failures).toBe(0);
  });

  it('never writes a throttled body, and says the feed — not the network — refused', async () => {
    // The bug tools/calibrate shipped as #69: the guard tested only for a
    // failed request, so a rejected body was cached and handed back, and every
    // later run read the hole straight out of `.cache/`.
    serve('', '');
    await expect(withoutThePause(() => fetchRoot('甘藍', '2026-09-01', '2026-09-01'))).rejects.toThrow(
      /unusable response/,
    );
    expect(cached()).toEqual([]);
    expect(stats.failures).toBe(1);
  });

  it('reports an unreachable retry as a fetch failure, whatever the first body was', async () => {
    serve('', null);
    await expect(withoutThePause(() => fetchRoot('甘藍', '2026-09-01', '2026-09-01'))).rejects.toThrow(
      /fetch failed/,
    );
    expect(cached()).toEqual([]);
  });

  it('refetches a half-written cache file instead of serving it as an empty window', async () => {
    // A run killed mid-write leaves a partial body. Trusting a file's mere
    // existence would hand back zero rows with no failure and no retry — the
    // #69 hole again, arriving by a different door.
    serve(answer([row('115.09.01')]));
    await fetchRoot('甘藍', '2026-09-01', '2026-09-01');
    const file = resolve(CACHE_DIR, cached()[0]);
    writeFileSync(file, '{"RS":"OK","Data":[{"TransD');

    const calls = serve(answer([row('115.09.01')]));
    expect(await fetchRoot('甘藍', '2026-09-01', '2026-09-01')).toHaveLength(1);
    expect(calls()).toBe(1); // it went back to the network rather than trusting the file
    expect(stats.cacheHits).toBe(0);
  });

  it('rejects an error envelope, which mentions RS but is not an answer', async () => {
    // The gate is the board's own `parsePage`: `RS: "OK"` or a real `Data`
    // array. A substring check for `"RS"` would take this for "nothing
    // traded", cache it forever, and delete that window from the measurement.
    const envelope = JSON.stringify({ RS: 'ERROR', Message: 'rate limit exceeded' });
    serve(envelope, envelope);
    await expect(withoutThePause(() => fetchRoot('甘藍', '2026-09-01', '2026-09-01'))).rejects.toThrow(
      /unusable response/,
    );
    expect(cached()).toEqual([]);
  });

  it('survives a Data that is not an array, rather than throwing past the cache write', async () => {
    // `RS: "OK"` makes it an answer; `parsePage` yields no rows from a
    // malformed `Data` instead of letting a spread throw on the way out.
    serve(JSON.stringify({ RS: 'OK', Data: { unexpected: true } }));
    expect(await fetchRoot('甘藍', '2026-09-01', '2026-09-01')).toEqual([]);
  });
});

describe('truncation', () => {
  it('halves a window MOA truncated rather than losing the days it dropped', async () => {
    // MOA keeps the NEWEST rows, so the first response is missing the start of
    // the window. Both halves come back complete and the run keeps every day.
    let call = 0;
    vi.stubGlobal('fetch', async () => {
      call += 1;
      const body = call === 1
        ? answer([row('115.09.04')], true)
        : answer([row(call === 2 ? '115.09.01' : '115.09.03')]);
      return { ok: true, text: async () => body };
    });

    const rows = await fetchRoot('甘藍', '2026-09-01', '2026-09-04');
    expect(call).toBe(3); // one truncated window, then its two halves
    expect(rows.map((r) => r.TransDate).sort()).toEqual(['115.09.01', '115.09.03']);
  });

  it('counts a single day that still truncates instead of passing it silently', async () => {
    // Halving has a floor, so the day is kept — but it holds only the newest
    // rows, i.e. some of its markets are missing. That reads exactly like a
    // real regional price difference, so the run has to say it happened.
    serve(answer([row('115.09.01')], true));
    expect(await fetchRoot('甘藍', '2026-09-01', '2026-09-01')).toHaveLength(1);
    // Named, not counted: which crop and which day is what makes it findable.
    expect([...stats.truncated]).toEqual(['甘藍 2026-09-01']);
  });

  it('does not count a window it could still halve', async () => {
    let call = 0;
    vi.stubGlobal('fetch', async () => {
      call += 1;
      return { ok: true, text: async () => answer([row('115.09.02')], call === 1) };
    });
    await fetchRoot('甘藍', '2026-09-01', '2026-09-02');
    expect([...stats.truncated]).toEqual([]);
  });
});

describe('date helpers', () => {
  it('covers a span in closed windows that never run past the end', () => {
    expect(windows('2026-09-01', '2026-09-05', 2)).toEqual([
      { from: '2026-09-01', to: '2026-09-02' },
      { from: '2026-09-03', to: '2026-09-04' },
      { from: '2026-09-05', to: '2026-09-05' },
    ]);
  });

  it('treats dates as calendar days, across a month boundary and a DST-shifting zone', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31');
    expect(spanDays({ from: '2026-08-31', to: '2026-09-01' })).toBe(2);
    expect(spanDays({ from: '2026-09-01', to: '2026-09-01' })).toBe(1);
  });
});
