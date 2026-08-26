/**
 * API service for VeggieRadar — talks to the Google Apps Script backend.
 *
 * The backend serves a daily-cached "board" of common vegetables so the app
 * loads instantly; search and trend are secondary actions.
 *
 * Set `VITE_API_BASE_URL` to your deployed GAS Web App URL. When it is unset
 * (local dev / offline), the app falls back to bundled sample data so the UI
 * is still fully explorable.
 */

import type { ApiResponse, BoardResponse, SearchResponse } from '../types/produce';
import { MOCK_BOARD } from './mockBoard';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string | undefined;

async function callApi(params: Record<string, string>): Promise<ApiResponse> {
  if (!API_BASE_URL) {
    return mockResponse(params);
  }
  const qs = new URLSearchParams(params).toString();
  const response = await fetch(`${API_BASE_URL}?${qs}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as ApiResponse;
}

/** Loads the daily price board (default view). */
export async function fetchBoard(): Promise<ApiResponse> {
  try {
    return await callApi({ action: 'board' });
  } catch (error) {
    return { error: '無法載入今日菜價，請稍後再試', message: String(error) };
  }
}

/** Searches produce by (colloquial) name. */
export async function searchProduce(query: string): Promise<ApiResponse> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { type: 'search', query, error: '請輸入查詢關鍵字' };
  }
  try {
    return await callApi({ action: 'search', query: trimmed });
  } catch (error) {
    return { error: '系統錯誤，請稍後再試', message: String(error), query: trimmed };
  }
}

/** Fetches the N-day price trend for a crop (drawer only). */
export async function fetchProduceTrend(cropName: string, days: number): Promise<number[]> {
  const trimmed = cropName.trim();
  if (!trimmed || !API_BASE_URL) return [];
  try {
    const qs = new URLSearchParams({ action: 'getTrend', cropName: trimmed, days: String(days) }).toString();
    const response = await fetch(`${API_BASE_URL}?${qs}`);
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.trend) ? data.trend.filter((n: unknown): n is number => typeof n === 'number') : [];
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
  return MOCK_BOARD as BoardResponse;
}
