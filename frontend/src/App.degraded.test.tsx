/**
 * App behaviour when the real backend is configured but unhealthy (GAS quota
 * exhaustion, network failure). Split from App.test.tsx because these paths
 * need `VITE_API_BASE_URL` stubbed before the module graph loads — the happy
 * path keeps running against the bundled mock board.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BoardResponse } from './types/produce';

const CACHED_BOARD: BoardResponse = {
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

async function loadApp() {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', 'https://gas.test/exec');
  // Dynamic import is required here: the api module reads VITE_API_BASE_URL at
  // module scope, so a static import would freeze the unstubbed value.
  const mod = await import('./App');
  return mod.default;
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App — backend unreachable', () => {
  it('serves the cached board with an honest banner instead of a blank error page', async () => {
    localStorage.setItem('veggieradar_last_board_v1', JSON.stringify(CACHED_BOARD));
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network down'))));
    const App = await loadApp();

    render(<App />);

    // The cached board paints immediately — no skeleton, no error screen.
    expect(await screen.findByText('高麗菜')).toBeInTheDocument();

    // After retries exhaust (~2.7 s of backoff), the banner explains the state.
    await waitFor(
      () => expect(screen.getByText(/目前連不上伺服器，顯示上次成功載入的行情/)).toBeInTheDocument(),
      { timeout: 6000 },
    );
    expect(screen.getByRole('button', { name: '重試' })).toBeInTheDocument();
    expect(screen.queryByText('無法載入今日菜價，請稍後再試')).not.toBeInTheDocument();
    expect(screen.getByText('高麗菜')).toBeInTheDocument();
  }, 10000);

  it('shows a busy notice for search transport failures — never 查無此品項', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).includes('action=search')) {
          return Promise.reject(new TypeError('network down'));
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(CACHED_BOARD) };
      }),
    );
    const App = await loadApp();

    render(<App />);
    await screen.findByText('高麗菜');

    fireEvent.change(screen.getByPlaceholderText(/搜尋蔬果/), { target: { value: '龍鬚菜' } });
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));

    expect(await screen.findByText('服務忙碌中，請稍後再試')).toBeInTheDocument();
    expect(screen.queryByText('查無此品項')).not.toBeInTheDocument();
  });
});
describe('App — recovery via the banner retry', () => {
  it('clears the offline banner once the backend answers again', async () => {
    localStorage.setItem('veggieradar_last_board_v1', JSON.stringify(CACHED_BOARD));
    let backendUp = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (!backendUp) return Promise.reject(new TypeError('network down'));
        return { ok: true, status: 200, text: async () => JSON.stringify(CACHED_BOARD) };
      }),
    );
    const App = await loadApp();

    render(<App />);
    await waitFor(
      () => expect(screen.getByText(/目前連不上伺服器/)).toBeInTheDocument(),
      { timeout: 6000 },
    );

    backendUp = true;
    fireEvent.click(screen.getByRole('button', { name: '重試' }));

    await waitFor(() => expect(screen.queryByText(/目前連不上伺服器/)).not.toBeInTheDocument());
    expect(screen.getByText('高麗菜')).toBeInTheDocument();
  }, 10000);
});