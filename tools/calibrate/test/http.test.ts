/**
 * What may be written into `.cache/`.
 *
 * The cache is why a refit costs no traffic on the second run, and it is also
 * the one place a bad response can outlive the run that fetched it: MOA
 * answers a burst with empty bodies, and `.cache/` is keyed by URL with no
 * expiry, so a throttled response stored once is read back by every later run
 * — `recalibrate.yml` included — until someone deletes the directory by hand.
 *
 * `accept` is the predicate that is supposed to prevent exactly that, so these
 * pin what it governs. `fetch` is stubbed and `CALIBRATE_CACHE_DIR` points at
 * a temporary directory: nothing here touches the network or a developer's
 * real cache.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CACHE = mkdtempSync(join(tmpdir(), 'calibrate-cache-'));
process.env.CALIBRATE_CACHE_DIR = CACHE;

// Imported after the variable is set: `CACHE_DIR` is resolved once, at import.
const { cachedText, stats, CACHE_DIR, RETRY_PAUSE_MS } = await import('../src/http.ts');

afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

/** Everything `namespace` holds, so "nothing was written" is a real assertion. */
const cached = (namespace: string): string[] => {
  try {
    return readdirSync(resolve(CACHE_DIR, namespace));
  } catch {
    return []; // the directory is only created by a write
  }
};

const readCached = (namespace: string): string =>
  readFileSync(resolve(CACHE_DIR, namespace, cached(namespace)[0]), 'utf8');

/** One stubbed response per call, in order. `null` fails the request. */
function serve(...bodies: (string | null)[]): void {
  let call = 0;
  vi.stubGlobal('fetch', async () => {
    const body = bodies[Math.min(call++, bodies.length - 1)];
    if (body === null) return { ok: false, text: async () => '' };
    return { ok: true, text: async () => body };
  });
}

/** Runs `work`, letting the retry pause elapse without waiting 1.5 s for it. */
async function withoutThePause<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const running = work();
    // Two turns: the pause is scheduled after the first attempt resolves.
    await vi.advanceTimersByTimeAsync(RETRY_PAUSE_MS * 2);
    return await running;
  } finally {
    vi.useRealTimers();
  }
}

let namespace = '';
let counter = 0;

beforeEach(() => {
  namespace = `ns${counter++}`; // a namespace of its own, so tests cannot read each other's cache
  Object.assign(stats, { requests: 0, cacheHits: 0, retries: 0, failures: 0 });
});

afterEach(() => vi.unstubAllGlobals());

describe('cachedText', () => {
  it('caches a body the caller accepts, without a retry', async () => {
    serve('{"RS":"OK"}');
    const body = await cachedText(namespace, 'https://example.test/a', (t) => t.includes('RS'));

    expect(body).toBe('{"RS":"OK"}');
    expect(readCached(namespace)).toBe('{"RS":"OK"}');
    expect(stats).toMatchObject({ requests: 1, retries: 0, failures: 0 });
  });

  it('reads the cache back instead of fetching again', async () => {
    serve('{"RS":"OK"}');
    const url = 'https://example.test/twice';
    await cachedText(namespace, url, (t) => t.includes('RS'));
    const again = await cachedText(namespace, url, (t) => t.includes('RS'));

    expect(again).toBe('{"RS":"OK"}');
    expect(stats).toMatchObject({ requests: 1, cacheHits: 1 });
  });

  it('caches the retry when the first body is rejected', async () => {
    serve('', '{"RS":"OK"}');
    const body = await withoutThePause(() =>
      cachedText(namespace, 'https://example.test/b', (t) => t.includes('RS')));

    expect(body).toBe('{"RS":"OK"}');
    expect(readCached(namespace)).toBe('{"RS":"OK"}'); // the rejected body is not what sits in .cache/
    expect(stats).toMatchObject({ requests: 2, retries: 1, failures: 0 });
  });

  it('throws and writes nothing when both bodies are rejected', async () => {
    // The regression: the final guard tested only `body === null`, so a body
    // the caller had rejected was written to the cache and returned — and
    // every later run read that hole straight back.
    serve('');
    await expect(withoutThePause(() =>
      cachedText(namespace, 'https://example.test/c', (t) => t.includes('RS')),
    )).rejects.toThrow(/unusable response/);

    expect(cached(namespace)).toEqual([]);
    expect(stats).toMatchObject({ requests: 2, retries: 1, failures: 1 });
  });

  it('names the failure for what it is: unreachable, not unusable', async () => {
    // The two are acted on differently — one is the network, the other is the
    // feed answering with something the caller cannot use.
    serve(null);
    await expect(withoutThePause(() =>
      cachedText(namespace, 'https://example.test/d', () => true),
    )).rejects.toThrow(/fetch failed/);

    expect(cached(namespace)).toEqual([]);
  });

  it('asks the predicate once per attempt, not once per decision', async () => {
    // It parses the body; re-deriving the verdict after the retry would run it
    // three times for a two-attempt fetch.
    const accept = vi.fn((t: string) => t.includes('RS'));
    serve('', '{"RS":"OK"}');
    await withoutThePause(() => cachedText(namespace, 'https://example.test/e', accept));

    expect(accept).toHaveBeenCalledTimes(2);
  });
});
