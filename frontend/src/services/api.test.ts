/**
 * Degraded-mode contract of the API layer. GAS fails in awkward ways when it
 * hits its quotas (30 simultaneous executions, daily URLFetch budget): queued
 * requests that hang, and platform HTML error pages instead of JSON. These
 * tests pin the behaviours that keep the app usable through all of that:
 * deadlines, retries, the localStorage board fallback, `transient` search
 * errors, and the per-session trend memo.
 *
 * `VITE_API_BASE_URL` is read at module scope, so each test re-imports the
 * module with the env stubbed to a real backend URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BoardResponse } from '../types/produce';

const BOARD: BoardResponse = {
  type: 'board',
  date: '2026-09-01',
  roc_date: '115.09.01',
  prev_date: '115.08.31',
  count: 1,
  generated_at: new Date().toISOString(),
  stale: false,
  items: [
    {
      code: 'LA1',
      name: '高麗菜',
      official_name: '甘藍',
      category: '葉菜類',
      avg_price: 23.4,
      catty_price: 14,
      retail_low: 35,
      retail_price: 43,
      retail_high: 55,
      retail_estimated: true,
      change_percent: -7,
      trade_volume: 640155,
      unit: '公斤',
      markets_count: 13,
    },
  ],
};

const CACHE_KEY = 'veggieradar_last_board_v1';

const jsonBody = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const htmlBody = () => ({
  ok: true,
  status: 200,
  text: async () => '<html><body>Service invoked too many times</body></html>',
});

async function loadApi() {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', 'https://gas.test/exec');
  // Dynamic import is required here: the module reads VITE_API_BASE_URL at
  // module scope, so a static import would freeze the unstubbed value.
  return await import('./api');
}
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchBoard — persistence and normalisation', () => {
  it('persists every good board for offline/over-quota fallback', async () => {
    const api = await loadApi();
    vi.stubGlobal('fetch', vi.fn(async () => jsonBody(BOARD)));

    const res = await api.fetchBoard();

    expect(res).toMatchObject({ type: 'board', count: 1 });
    expect(api.readCachedBoard()?.items[0]?.name).toBe('高麗菜');
    expect(localStorage.getItem(CACHE_KEY)).toContain('甘藍');
  });

  it('normalises GAS platform HTML pages into a friendly error after retries', async () => {
    vi.useFakeTimers();
    const api = await loadApi();
    const fetchMock = vi.fn(async () => htmlBody());
    vi.stubGlobal('fetch', fetchMock);

    const pending = api.fetchBoard();
    await vi.runAllTimersAsync();
    const res = await pending;

    expect(res).toMatchObject({ error: '無法載入今日菜價，請稍後再試', transient: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Raw HTML stays in the console, never in the UI.
    expect(console.warn).toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain('<html>');
  });

  it('abandons a hung request at the deadline instead of holding the skeleton', async () => {
    vi.useFakeTimers();
    const api = await loadApi();
    const fetchMock = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
      const { promise, reject } = Promise.withResolvers<never>();
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      return promise;
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = api.fetchBoard();
    await vi.runAllTimersAsync();
    const res = await pending;

    expect(res).toMatchObject({ error: '無法載入今日菜價，請稍後再試', transient: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('readCachedBoard — validation', () => {
  it.each([
    ['garbage', 'not json'],
    ['wrong shape', JSON.stringify({ hello: 1 })],
    ['empty board', JSON.stringify({ type: 'board', items: [] })],
  ])('rejects a corrupt cache entry (%s)', async (_name, raw) => {
    const api = await loadApi();
    localStorage.setItem(CACHE_KEY, raw);
    expect(api.readCachedBoard()).toBeNull();
  });
});

describe('searchProduce — transient failures', () => {
  it('marks transport failures transient instead of pretending 查無此品項', async () => {
    const api = await loadApi();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network down'))));

    const res = await api.searchProduce('高麗菜');

    expect(res).toMatchObject({ error: '服務忙碌中，請稍後再試', transient: true, query: '高麗菜' });
  });
});

describe('fetchProduceTrend — session memo', () => {
  it('serves repeat trend requests from memory', async () => {
    const api = await loadApi();
    const fetchMock = vi.fn(async () => jsonBody({ cropName: '甘藍', days: 7, trend: [1, null, 2.5] }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await api.fetchProduceTrend('甘藍', 7)).toEqual([1, 2.5]);
    expect(await api.fetchProduceTrend('甘藍', 7)).toEqual([1, 2.5]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never memoises a failure, so reopening the drawer can recover', async () => {
    const api = await loadApi();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValue(jsonBody({ cropName: '甘藍', days: 7, trend: [3] }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await api.fetchProduceTrend('甘藍', 7)).toEqual([]);
    expect(await api.fetchProduceTrend('甘藍', 7)).toEqual([3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});