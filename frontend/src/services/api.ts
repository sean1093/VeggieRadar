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
 * Read order for the board (README §2): the localStorage copy paints first,
 * then the static mirror published next to the app on Pages, and only a
 * missing or stale mirror reaches GAS. `useBoard` owns that order; this module
 * owns the three ways to obtain a board.
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
import { boardMismatch } from '../types/board.schema';
import { boardAgeMs, BOARD_MAX_AGE_MS } from '../lib/utils/freshness';
import { MOCK_BOARD } from './mockBoard';
import { track } from '../lib/analytics';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string | undefined;

// Deadlines per action. The board blocks the whole UI but falls back to the
// cached copy, so it fails reasonably fast. Search is user-initiated (higher
// waiting tolerance) and its live-miss path measures 8-31 s in production —
// a warm miss fits under 15 s, and a cold one that times out primes the
// backend's trade-date cache so the offered retry succeeds.
//
// Trend needs 15 s too, and the earlier 8 s was a measurement error on my
// part: a COLD trend crawl was measured at 10.0 s in production, so with an
// 8 s deadline the first visitor after each hourly cache expiry always timed
// out and saw 「暫無趨勢資料」 — their request only warmed the cache for
// everyone else. Waiting costs nothing visible here: the drawer's prices are
// already rendered and the chart slot holds its height.
const BOARD_TIMEOUT_MS = 12_000;
const SEARCH_TIMEOUT_MS = 15_000;
const TREND_TIMEOUT_MS = 15_000;
// The mirror is same-origin static JSON on a CDN, so it either answers in
// tens of milliseconds or is not going to help: a longer deadline would only
// delay the GAS request that a missing mirror needs.
const STATIC_BOARD_TIMEOUT_MS = 3_000;

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

/**
 * Persists a board as the offline/over-quota fallback. Best-effort: private
 * mode and a full quota both throw, and neither is worth failing a load over.
 */
export function writeCachedBoard(board: BoardResponse): void {
  if (!API_BASE_URL) return;
  try {
    localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify(board));
  } catch {
    // Private mode / storage quota — the cache is best-effort.
  }
}

/**
 * Whether a board is current enough to serve without asking GAS at all
 * (`BOARD_MAX_AGE_MS`, the backend's own threshold). Pure, and exported
 * because the read order in `useBoard` turns on it.
 *
 * An unusable `generated_at` counts as not fresh — deliberately the opposite
 * of `describeFreshness`, which stays quiet then. Being unable to date a board
 * is a reason to ask the authority, but not a reason to tell a shopper the
 * prices are old.
 */
export function isFreshEnough(board: BoardResponse, now: number = Date.now()): boolean {
  const age = boardAgeMs(board.generated_at, now);
  return age !== null && age <= BOARD_MAX_AGE_MS;
}

/**
 * Measures a live board against the executable contract (`types/board.schema.ts`)
 * and says whether it broke it.
 *
 * Report-only for the GAS board, on purpose: a renamed field must not blank
 * the board a shopper is standing in front of, and the UI already treats every
 * derived field as optional (README §3). So the violation is published —
 * console for whoever is looking, `board_schema_mismatch` for the rate over
 * time — and the board is served and cached exactly as it arrived. The mirror
 * is the one caller that acts on the return value, because there it means the
 * published file predates a contract change and a fresher authority (GAS) is
 * still one request away.
 */
function reportSchemaMismatch(board: BoardResponse): boolean {
  const mismatch = boardMismatch(board);
  if (!mismatch) return false;
  console.warn('VeggieRadar: board schema mismatch', mismatch.path, mismatch.message);
  track('board_schema_mismatch', { path: mismatch.path });
  return true;
}

/**
 * The board mirror this app is deployed with (`<base>data/board.json`, README
 * §2), or null when there is no usable one.
 *
 * The board is 99 % of the traffic and was 99 % of the GAS executions, all of
 * them cache reads that a static file serves from the same CDN as the app —
 * for ~50 ms instead of a ~2 s round trip, and without touching the
 * 30-simultaneous-execution ceiling or a cold start's 404.
 *
 * Every failure collapses to null (no mirror deployed yet, a 404, a truncated
 * or non-JSON body, a payload that broke the contract, the deadline), because
 * the caller's answer to all of them is the same: ask GAS.
 */
export async function fetchStaticBoard(): Promise<BoardResponse | null> {
  // Offline dev has the bundled board and no Pages deploy behind it.
  if (!API_BASE_URL) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATIC_BOARD_TIMEOUT_MS);
  try {
    // `no-cache` revalidates rather than reading the HTTP cache: the URL never
    // changes, so a cached copy would otherwise outlive the board inside it.
    const response = await fetch(`${import.meta.env.BASE_URL}data/board.json`, {
      cache: 'no-cache',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const board = JSON.parse(await response.text()) as BoardResponse;
    // A board without items is not a board the UI can render, and an empty
    // one is what a half-written mirror would look like.
    if (!board || board.type !== 'board' || !Array.isArray(board.items) || board.items.length === 0) {
      return null;
    }
    if (reportSchemaMismatch(board)) return null;
    return board;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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
      if (isApiError(res) || res.type !== 'board') return res;
      // A board without an item list is not a board the UI can render — every
      // consumer maps over `items` — and it is not a transport failure either,
      // so retrying would only spend the backoff on the same body. Report the
      // contract break and degrade the way an outage does: the cached board
      // plus the connection note, never a crash.
      if (!Array.isArray(res.items)) {
        reportSchemaMismatch(res);
        return { error: '無法載入今日菜價，請稍後再試', message: 'board without items', transient: true };
      }
      if (res.items.length > 0) {
        // Only boards that carry data are held to the contract: the `warming`
        // placeholder and 「近期查無交易資料」 legitimately ship without a
        // trading date (§3), and reporting those as drift would drown the
        // signal in known-good degraded states.
        reportSchemaMismatch(res);
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
    )) as { trend?: unknown; error?: unknown };
    // doGet answers a thrown handler with `{ error }` and HTTP 200. That is a
    // backend failure, not a crop without data — the two must not share a
    // bucket, or an outage reads as "no 7-day trend".
    if (data.error) {
      track('trend_result', { outcome: 'failed', reason: 'backend' });
      return [];
    }
    const trend = Array.isArray(data.trend)
      ? data.trend.filter((n: unknown): n is number => typeof n === 'number')
      : [];
    // Reported only for real requests (memo hits above are free), so the
    // ratio tells whether the 15 s deadline is still the right one.
    track('trend_result', { outcome: trend.length ? 'ok' : 'empty' });
    if (trend.length) {
      if (trendCache.size >= TREND_CACHE_MAX) {
        const oldest = trendCache.keys().next().value;
        if (oldest !== undefined) trendCache.delete(oldest);
      }
      trendCache.set(key, trend);
    }
    return trend;
  } catch (error) {
    track('trend_result', {
      outcome: 'failed',
      reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'error',
    });
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