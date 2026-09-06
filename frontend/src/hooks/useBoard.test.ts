import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { boardItems, useBoard } from './useBoard';
import { fetchBoard, fetchStaticBoard, readCachedBoard, writeCachedBoard } from '../services/api';
import type * as ApiModule from '../services/api';
import type { ApiResponse, BoardResponse, ProduceItem } from '../types/produce';

// Only the three ways a board arrives are stubbed. `isFreshEnough` stays real,
// so these tests exercise the actual 6 h rule the read order turns on rather
// than a mock's opinion of it.
vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  fetchBoard: vi.fn(),
  fetchStaticBoard: vi.fn(),
  readCachedBoard: vi.fn(),
  writeCachedBoard: vi.fn(),
}));

const fetchBoardMock = vi.mocked(fetchBoard);
const fetchStaticBoardMock = vi.mocked(fetchStaticBoard);
const readCachedBoardMock = vi.mocked(readCachedBoard);
const writeCachedBoardMock = vi.mocked(writeCachedBoard);

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
const REFRESHING = '資料更新中，稍後重新整理可看到最新行情';
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

/** A board whose last crawl is `hoursAgo` old, judged by the real 6 h rule. */
function agedBoard(date: string, hoursAgo: number): BoardResponse {
  return board(date, { generated_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() });
}

describe('useBoard', () => {
  beforeEach(() => {
    readCachedBoardMock.mockReturnValue(null);
    // No mirror is the pre-#13 world, which the first block of tests pins.
    fetchStaticBoardMock.mockResolvedValue(null);
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
    expect(gtag).toHaveBeenCalledWith('event', 'board_loaded', { source: 'gas', stale: false, age_bucket: '<1h' });
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

    expect(result.current.freshness.note).toBe(REFRESHING);
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

  it('lets a retry win over a first read that is still in flight', async () => {
    // The banner's 重試 can be pressed while the mount read is still waiting
    // on GAS. The slow first answer — here a failure — must not land on top
    // of the retry's board.
    const first = Promise.withResolvers<ApiResponse>();
    const second = Promise.withResolvers<ApiResponse>();
    fetchBoardMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useBoard());
    await act(async () => {});
    expect(result.current.status).toEqual({ kind: 'loading' });

    act(() => result.current.reload());
    const recovered = board('2026-09-03');
    await act(async () => second.resolve(recovered));
    expect(result.current.status).toEqual({ kind: 'ready', board: recovered, source: 'gas' });

    await act(async () => first.resolve(FAILURE));
    expect(result.current.status).toEqual({ kind: 'ready', board: recovered, source: 'gas' });
  });

  it('reads the mirror once and revalidates once per mount', async () => {
    renderHook(() => useBoard());
    await act(async () => {});
    expect(fetchStaticBoardMock).toHaveBeenCalledTimes(1);
    expect(fetchBoardMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The mirror (README §2) is why the board no longer costs a GAS execution:
   * a fresh one answers the visit outright, and only a stale or missing one
   * falls through to the backend — whose `readBoard` then queues the rebuild
   * that unsticks the pipeline, so the self-heal chain is unchanged.
   */
  describe('static mirror', () => {
    it('serves a fresh mirror and never touches GAS', async () => {
      const mirror = agedBoard('2026-09-02', 2);
      fetchStaticBoardMock.mockResolvedValue(mirror);
      const gtag = vi.fn();
      vi.stubGlobal('gtag', gtag);

      const { result } = renderHook(() => useBoard());

      await waitFor(() => expect(result.current.status).toEqual({ kind: 'ready', board: mirror, source: 'static' }));
      expect(fetchBoardMock).not.toHaveBeenCalled();
      // The board on screen becomes this browser's offline fallback too, so a
      // later visit with no network still has today's prices.
      expect(writeCachedBoardMock).toHaveBeenCalledWith(mirror);
      expect(gtag).toHaveBeenCalledWith('event', 'board_loaded', {
        source: 'static',
        stale: false,
        age_bucket: '1-6h',
      });
    });

    it('paints a stale mirror at once, then lets GAS overwrite it', async () => {
      // A mirror this old means the scheduled deploy stopped running: the file
      // still claims `stale: false`, and the age is what contradicts it.
      const mirror = agedBoard('2026-09-01', 20);
      const fresh = board('2026-09-02');
      fetchStaticBoardMock.mockResolvedValue(mirror);
      const { promise, resolve } = Promise.withResolvers<ApiResponse>();
      fetchBoardMock.mockReturnValue(promise);

      const { result } = renderHook(() => useBoard());

      await waitFor(() => expect(result.current.status).toEqual({ kind: 'ready', board: mirror, source: 'static' }));
      expect(result.current.freshness.note).toBe(REFRESHING);
      expect(fetchBoardMock).toHaveBeenCalledTimes(1);
      expect(writeCachedBoardMock).not.toHaveBeenCalled();

      await act(async () => resolve(fresh));
      expect(result.current.status).toEqual({ kind: 'ready', board: fresh, source: 'gas' });
      // GAS answered, so the board is no longer the one being explained away.
      expect(result.current.freshness.note).not.toBe(REFRESHING);
    });

    it('keeps the stale mirror on screen when GAS is down as well', async () => {
      const mirror = agedBoard('2026-09-01', 20);
      // The browser also has an older localStorage copy; the mirror wins the
      // fallback because it is what the shopper is already reading, and
      // swapping in different old prices on a failure explains nothing.
      readCachedBoardMock.mockReturnValue(board('2026-08-30'));
      fetchStaticBoardMock.mockResolvedValue(mirror);
      fetchBoardMock.mockResolvedValue(FAILURE);
      const gtag = vi.fn();
      vi.stubGlobal('gtag', gtag);

      const { result } = renderHook(() => useBoard());

      await waitFor(() =>
        expect(result.current.status).toEqual({
          kind: 'degraded',
          board: mirror,
          source: 'static',
          reason: UNREACHABLE,
        }),
      );
      expect(boardItems(result.current.status)).toEqual([CABBAGE]);
      // `served: 'static'` is a different incident from `cache`: the mirror
      // going stale means the scheduled deploy stopped too.
      expect(gtag).toHaveBeenCalledWith('event', 'board_fallback', { served: 'static' });
    });

    it('follows the same order on reload', async () => {
      fetchBoardMock.mockResolvedValue(FAILURE);
      const { result } = renderHook(() => useBoard());
      await waitFor(() => expect(result.current.status.kind).toBe('error'));
      expect(fetchBoardMock).toHaveBeenCalledTimes(1);

      // The retry lands after a deploy republished the mirror.
      const mirror = agedBoard('2026-09-02', 1);
      fetchStaticBoardMock.mockResolvedValue(mirror);

      await act(async () => result.current.reload());
      expect(result.current.status).toEqual({ kind: 'ready', board: mirror, source: 'static' });
      expect(fetchBoardMock).toHaveBeenCalledTimes(1); // no second GAS call
    });
  });
});
