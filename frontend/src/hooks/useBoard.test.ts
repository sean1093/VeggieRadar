import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { boardItems, useBoard } from './useBoard';
import { fetchBoard, readCachedBoard } from '../services/api';
import type { ApiResponse, BoardResponse, ProduceItem } from '../types/produce';

vi.mock('../services/api', () => ({
  fetchBoard: vi.fn(),
  readCachedBoard: vi.fn(),
}));

const fetchBoardMock = vi.mocked(fetchBoard);
const readCachedBoardMock = vi.mocked(readCachedBoard);

const CABBAGE: ProduceItem = {
  code: 'LA1',
  name: '高麗菜',
  official_name: '甘藍',
  category: '葉菜類',
  avg_price: 22.1,
  catty_price: 13.3,
  change_percent: -13.5,
  trade_volume: 570700,
  unit: '公斤',
  markets_count: 13,
};

const UNREACHABLE = '目前連不上伺服器，顯示上次成功載入的行情';
const FAILURE: ApiResponse = { error: '無法載入今日菜價，請稍後再試', transient: true };

function board(date: string, over: Partial<BoardResponse> = {}): BoardResponse {
  return {
    type: 'board',
    date,
    roc_date: '115.09.02',
    prev_date: '115.09.01',
    count: 1,
    items: [CABBAGE],
    generated_at: new Date().toISOString(),
    stale: false,
    ...over,
  };
}

describe('useBoard', () => {
  beforeEach(() => {
    readCachedBoardMock.mockReturnValue(null);
    fetchBoardMock.mockResolvedValue(board('2026-09-02'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('paints the cached board first and swaps in the backend answer', async () => {
    const cached = board('2026-09-01');
    const fresh = board('2026-09-02');
    readCachedBoardMock.mockReturnValue(cached);
    const { promise, resolve } = Promise.withResolvers<ApiResponse>();
    fetchBoardMock.mockReturnValue(promise);
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);

    const { result } = renderHook(() => useBoard());

    // A revalidation in flight is not a degradation: prices are on screen and
    // nothing may hint at a problem yet.
    expect(result.current.status).toEqual({ kind: 'ready', board: cached, source: 'cache' });
    expect(gtag).not.toHaveBeenCalled();

    await act(async () => resolve(fresh));
    expect(result.current.status).toEqual({ kind: 'ready', board: fresh, source: 'gas' });
    expect(gtag).toHaveBeenCalledWith('event', 'board_loaded', { stale: false, age_bucket: '<1h' });
  });

  it('starts on the skeleton when nothing is cached', async () => {
    const fresh = board('2026-09-02');
    const { promise, resolve } = Promise.withResolvers<ApiResponse>();
    fetchBoardMock.mockReturnValue(promise);

    const { result } = renderHook(() => useBoard());

    expect(result.current.status).toEqual({ kind: 'loading' });
    expect(boardItems(result.current.status)).toEqual([]);
    expect(result.current.freshness).toEqual({ note: null, checkedAt: null });

    await act(async () => resolve(fresh));
    expect(result.current.status).toEqual({ kind: 'ready', board: fresh, source: 'gas' });
    expect(boardItems(result.current.status)).toEqual([CABBAGE]);
  });

  it('degrades onto the cached board — old prices, a reason and a retry beat a blank page', async () => {
    const cached = board('2026-09-01');
    readCachedBoardMock.mockReturnValue(cached);
    fetchBoardMock.mockResolvedValue(FAILURE);
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);

    const { result } = renderHook(() => useBoard());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        kind: 'degraded',
        board: cached,
        source: 'cache',
        reason: UNREACHABLE,
      }),
    );
    // The prices stay usable, and the freshness notice still describes the
    // board rather than the outage.
    expect(boardItems(result.current.status)).toEqual([CABBAGE]);
    expect(result.current.freshness.checkedAt).not.toBeNull();
    expect(gtag).toHaveBeenCalledWith('event', 'board_fallback', { served: 'cache' });
    expect(gtag).not.toHaveBeenCalledWith('event', 'board_loaded', expect.anything());
  });

  it('errors with the backend message when there is nothing to fall back on', async () => {
    fetchBoardMock.mockResolvedValue(FAILURE);
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);

    const { result } = renderHook(() => useBoard());

    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: 'error', message: '無法載入今日菜價，請稍後再試' }),
    );
    expect(boardItems(result.current.status)).toEqual([]);
    // An error screen with a freshness note is exactly what the union makes
    // impossible: there is no board to describe.
    expect(result.current.freshness).toEqual({ note: null, checkedAt: null });
    expect(gtag).toHaveBeenCalledWith('event', 'board_fallback', { served: 'none' });
  });

  it('explains a board the backend flagged stale', async () => {
    readCachedBoardMock.mockReturnValue(board('2026-09-01', { stale: true }));
    const { result } = renderHook(() => useBoard());

    expect(result.current.freshness.note).toBe('資料更新中，稍後重新整理可看到最新行情');
    await act(async () => {});
  });

  it('re-reads the cache on reload, so a retry paints before the network answers', async () => {
    fetchBoardMock.mockResolvedValue(FAILURE);
    const { result } = renderHook(() => useBoard());
    await waitFor(() => expect(result.current.status.kind).toBe('error'));

    // A board has landed in the cache since mount and the backend is back up.
    const cached = board('2026-09-01');
    const recovered = board('2026-09-03');
    readCachedBoardMock.mockReturnValue(cached);
    const { promise, resolve } = Promise.withResolvers<ApiResponse>();
    fetchBoardMock.mockReturnValue(promise);

    act(() => result.current.reload());
    expect(result.current.status).toEqual({ kind: 'ready', board: cached, source: 'cache' });

    await act(async () => resolve(recovered));
    expect(result.current.status).toEqual({ kind: 'ready', board: recovered, source: 'gas' });
  });

  it('returns to the skeleton when a reload has no cache to paint', async () => {
    fetchBoardMock.mockResolvedValue(FAILURE);
    const { result } = renderHook(() => useBoard());
    await waitFor(() => expect(result.current.status.kind).toBe('error'));

    const { promise, resolve } = Promise.withResolvers<ApiResponse>();
    fetchBoardMock.mockReturnValue(promise);
    act(() => result.current.reload());
    expect(result.current.status).toEqual({ kind: 'loading' });

    await act(async () => resolve(FAILURE));
    expect(result.current.status).toEqual({ kind: 'error', message: '無法載入今日菜價，請稍後再試' });
  });

  it('revalidates once per mount', async () => {
    renderHook(() => useBoard());
    await act(async () => {});
    expect(fetchBoardMock).toHaveBeenCalledTimes(1);
  });
});
