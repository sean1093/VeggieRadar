/**
 * API service for VeggieRadar — talks to the Google Apps Script backend.
 *
 * The backend serves a daily-cached "board" of common vegetables so the app
 * loads instantly; search and trend are secondary actions.
 *
 * Set `VITE_API_BASE_URL` to your deployed GAS Web App URL. When it is unset
 * (local dev / offline), the app falls back to bundled sample data so the UI
 * is still fully explorable.
 *
 * Degraded-mode contract (GAS has hard quotas — 30 simultaneous executions,
 * a daily URLFetch budget — and fails in awkward ways when it hits them):
 *
 *   - Every request carries a deadline. Over-capacity GAS queues requests;
 *     without a deadline a queued call holds the loading skeleton for 60 s+.
 *   - Platform errors arrive as HTML pages, not JSON from `doGet`. Those are
 *     normalised into friendly errors; the raw body goes to the console only.
 *   - The last good board is persisted to localStorage. When the backend is
 *     unreachable the app serves that instead of a blank page — old prices
 *     beat no prices for a shopper standing at a stall.
 *   - Search transport failures are marked `transient` so the UI can say
 *     "busy, retry" instead of lying with 查無此品項.
 */

import { isApiError, type ApiResponse, type BoardResponse, type SearchResponse } from '../types/produce';
import { MOCK_BOARD } from './mockBoard';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string | undefined;

// Deadlines per action. The board blocks the whole UI but falls back to the
// cached copy, so it fails reasonably fast. Search is user-initiated (higher
// waiting tolerance) and its live-miss path measures 8-31 s in production —
// a warm miss fits under 15 s, and a cold one that times out primes the
// backend's trade-date cache so the offered retry succeeds. Trend degrades
// silently, so it gets the short leash.
const BOARD_TIMEOUT_MS = 12_000;
const SEARCH_TIMEOUT_MS = 15_000;
const TREND_TIMEOUT_MS = 8_000;

const BOARD_CACHE_KEY = 'veggieradar_last_board_v1';

/**
 * Fetches one backend action with a deadline and a JSON guarantee.
 * Throws on HTTP errors, timeouts and non-JSON bodies — callers turn those
 * into cached fallbacks or friendly messages.
 */
async function fetchJson(params: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const qs = new URLSearchParams(params).toString();
    const response = await fetch(`${API_BASE_URL}?${qs}`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // GAS over-capacity/limit errors are platform HTML pages that never went
      // through doGet's JSON error handling. Keep the evidence in the console,
      // never in the UI.
      console.warn('VeggieRadar: non-JSON backend response', response.status, text.slice(0, 200));
      throw new Error('backend returned non-JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

async function callApi(params: Record<string, string>, timeoutMs: number): Promise<ApiResponse> {
  if (!API_BASE_URL) {
    return mockResponse(params);
  }
  return (await fetchJson(params, timeoutMs)) as ApiResponse;
}

/**
 * Last board that loaded successfully, or null. Only meaningful when a real
 * backend is configured — offline dev already has the bundled board.
 */
export function readCachedBoard(): BoardResponse | null {
  if (!API_BASE_URL) return null;
  try {
    const raw = localStorage.getItem(BOARD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BoardResponse;
    if (!parsed || parsed.type !== 'board' || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedBoard(board: BoardResponse): void {
  if (!API_BASE_URL) return;
  try {
    localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify(board));
  } catch {
    // Private mode / storage quota — the cache is best-effort.
  }
}

/**
 * Loads the daily price board (default view). GAS web apps can return a
 * transient 404 on a cold start, so retry a couple of times before failing.
 * Every good board is persisted for offline/over-quota fallback.
 */
export async function fetchBoard(): Promise<ApiResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await callApi({ action: 'board' }, BOARD_TIMEOUT_MS);
      if (!isApiError(res) && res.type === 'board' && res.items.length > 0) {
        writeCachedBoard(res);
      }
      return res;
    } catch (error) {
      lastError = error;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 900 * (attempt + 1));
      await promise;
    }
  }
  return { error: '無法載入今日菜價，請稍後再試', message: String(lastError), transient: true };
}

/** Searches produce by (colloquial) name. */
export async function searchProduce(query: string): Promise<ApiResponse> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { type: 'search', query, error: '請輸入查詢關鍵字' };
  }
  try {
    return await callApi({ action: 'search', query: trimmed }, SEARCH_TIMEOUT_MS);
  } catch (error) {
    // Transport failure — NOT "no such produce". `transient` keeps the UI from
    // presenting a busy backend as an empty search result.
    return { error: '服務忙碌中，請稍後再試', message: String(error), query: trimmed, transient: true };
  }
}

// One trend per crop barely moves within a session, and each miss costs a GAS
// execution. Successful trends are memoised; failures are not, so a closed
// drawer can retry on reopen.
const trendCache = new Map<string, number[]>();
const TREND_CACHE_MAX = 50;

/** Fetches the N-day price trend for a crop (drawer only). */
export async function fetchProduceTrend(cropName: string, days: number): Promise<number[]> {
  const trimmed = cropName.trim();
  if (!trimmed || !API_BASE_URL) return [];
  const key = `${trimmed}:${days}`;
  const cached = trendCache.get(key);
  if (cached) return cached;
  try {
    const data = (await fetchJson(
      { action: 'getTrend', cropName: trimmed, days: String(days) },
      TREND_TIMEOUT_MS,
    )) as { trend?: unknown };
    const trend = Array.isArray(data.trend)
      ? data.trend.filter((n: unknown): n is number => typeof n === 'number')
      : [];
    if (trend.length) {
      if (trendCache.size >= TREND_CACHE_MAX) {
        const oldest = trendCache.keys().next().value;
        if (oldest !== undefined) trendCache.delete(oldest);
      }
      trendCache.set(key, trend);
    }
    return trend;
  } catch {
    return [];
  }
}

/** Offline / no-backend fallback used during local development. */
function mockResponse(params: Record<string, string>): ApiResponse {
  if (params.action === 'search') {
    const q = params.query;
    const items = MOCK_BOARD.items.filter(
      (it) => it.name.includes(q) || it.official_name.includes(q),
    );
    const search: SearchResponse = {
      type: 'search',
      query: q,
      date: MOCK_BOARD.date,
      count: items.length,
      items,
    };
    return items.length ? search : { type: 'search', query: q, error: '查無此品項', items: [] };
  }
  // The bundled snapshot was "fetched" just now, so it is fresh by definition —
  // stamping the real time keeps the freshness notice honest offline: the UI
  // explains the old trading date as a market closure, not a broken pipeline.
  return { ...(MOCK_BOARD as BoardResponse), generated_at: new Date().toISOString(), stale: false };
}