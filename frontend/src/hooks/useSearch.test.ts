import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { itemsFor, useSearch, type SearchStatus } from './useSearch';
import { searchProduce } from '../services/api';
import type { ApiResponse, ProduceItem } from '../types/produce';

vi.mock('../services/api', () => ({ searchProduce: vi.fn() }));

const searchProduceMock = vi.mocked(searchProduce);

function item(name: string, officialName: string, category = '葉菜類'): ProduceItem {
  return {
    code: name,
    name,
    official_name: officialName,
    category,
    avg_price: 22.1,
    catty_price: 13.3,
    change_percent: -1.5,
    trade_volume: 5000,
    unit: '公斤',
    markets_count: 6,
  };
}

const CABBAGE = item('高麗菜', '甘藍');
const BANANA = item('香蕉', '香蕉', '水果');
const BOARD = [CABBAGE, BANANA];

const CHAYOTE = item('龍鬚菜', '隼人瓜嫩梢');
const FERN = item('山蘇', '台灣山蘇花');

const found = (items: ProduceItem[]): ApiResponse => ({
  type: 'search',
  query: 'q',
  date: '2026-09-02',
  count: items.length,
  items,
});

describe('useSearch', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('starts idle and treats a blank query as a reset', async () => {
    const { result } = renderHook(() => useSearch(BOARD));
    expect(result.current.status).toEqual({ kind: 'idle' });

    await act(async () => result.current.search('   '));
    expect(result.current.query).toBe('');
    expect(result.current.status).toEqual({ kind: 'idle' });
    expect(searchProduceMock).not.toHaveBeenCalled();
  });

  it('answers a board hit instantly, without a request', async () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const { result } = renderHook(() => useSearch(BOARD));

    await act(async () => result.current.search(' 高麗 '));
    expect(result.current.query).toBe('高麗');
    expect(result.current.status).toEqual({ kind: 'local', items: [CABBAGE] });
    expect(searchProduceMock).not.toHaveBeenCalled();
    expect(gtag).toHaveBeenCalledWith('event', 'search_result', { outcome: 'local_hit', query_length: 2 });
  });

  it('matches the MOA official name as well as the everyday one', async () => {
    const { result } = renderHook(() => useSearch(BOARD));
    await act(async () => result.current.search('甘藍'));
    expect(result.current.status).toEqual({ kind: 'local', items: [CABBAGE] });
  });

  it('recomputes a board hit against a revalidated board instead of a frozen copy', async () => {
    const { result, rerender } = renderHook(({ board }) => useSearch(board), {
      initialProps: { board: BOARD },
    });
    await act(async () => result.current.search('高麗'));
    expect(result.current.status).toEqual({ kind: 'local', items: [CABBAGE] });

    // The background revalidation lands a newer price for the same crop: the
    // query on screen must follow the board, not keep yesterday's row.
    const repriced = { ...CABBAGE, catty_price: 18.4 };
    rerender({ board: [repriced, BANANA] });
    expect(result.current.status).toEqual({ kind: 'local', items: [repriced] });
  });

  it('keeps a live query visible as searching, then lands the remote rows', async () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const { promise, resolve } = Promise.withResolvers<ApiResponse>();
    searchProduceMock.mockReturnValue(promise);
    const { result } = renderHook(() => useSearch(BOARD));

    await act(async () => {
      result.current.search('龍鬚菜');
    });
    expect(result.current.status).toEqual({ kind: 'searching' });
    expect(searchProduceMock).toHaveBeenCalledWith('龍鬚菜');

    await act(async () => resolve(found([CHAYOTE])));
    expect(result.current.status).toEqual({ kind: 'remote', items: [CHAYOTE] });
    expect(gtag).toHaveBeenCalledWith('event', 'search_result', { outcome: 'remote_hit', query_length: 3 });
  });

  it('reports a definitive miss as not_found, carrying the backend’s suggestion', async () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    // The backend knows the crop catalogue; its 「試試：…」 beats any fixed trio
    // this hook could invent, so the line has to survive into the state.
    searchProduceMock.mockResolvedValue({ error: '查無此品項', items: [], suggestion: '試試：甘藍、甘薯葉' });
    const { result } = renderHook(() => useSearch(BOARD));

    await act(async () => result.current.search('龍鬚菜'));
    expect(result.current.status).toEqual({ kind: 'not_found', suggestion: '試試：甘藍、甘薯葉' });
    expect(gtag).toHaveBeenCalledWith('event', 'search_result', { outcome: 'not_found', query_length: 3 });
  });

  it('treats an empty successful answer as a miss too', async () => {
    searchProduceMock.mockResolvedValue(found([]));
    const { result } = renderHook(() => useSearch(BOARD));

    await act(async () => result.current.search('龍鬚菜'));
    expect(result.current.status).toEqual({ kind: 'not_found' });
  });

  it('keeps a busy backend apart from 查無此品項, and never sends the text', async () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    searchProduceMock.mockResolvedValue({ error: '服務忙碌中，請稍後再試', transient: true });
    const { result } = renderHook(() => useSearch(BOARD));

    await act(async () => result.current.search('龍鬚菜'));
    expect(result.current.status).toEqual({ kind: 'transient', message: '服務忙碌中，請稍後再試' });
    expect(gtag).toHaveBeenCalledWith('event', 'search_result', { outcome: 'transient', query_length: 3 });
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('龍鬚菜');
  });

  it('lets a newer query win, whatever order the answers arrive in', async () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const slow = Promise.withResolvers<ApiResponse>();
    const quick = Promise.withResolvers<ApiResponse>();
    searchProduceMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(quick.promise);
    const { result } = renderHook(() => useSearch(BOARD));

    await act(async () => {
      result.current.search('龍鬚菜');
    });
    await act(async () => {
      result.current.search('山蘇');
    });

    await act(async () => quick.resolve(found([FERN])));
    expect(result.current.status).toEqual({ kind: 'remote', items: [FERN] });

    // The abandoned query answers late; it must not repaint the box.
    await act(async () => slow.resolve(found([CHAYOTE])));
    expect(result.current.status).toEqual({ kind: 'remote', items: [FERN] });
    expect(result.current.query).toBe('山蘇');
    // One query, one outcome — the discarded answer is not counted either.
    expect(gtag.mock.calls.filter(([, name]) => name === 'search_result')).toHaveLength(1);
  });

  it('clears the box and voids the answer still in flight', async () => {
    const { promise, resolve } = Promise.withResolvers<ApiResponse>();
    searchProduceMock.mockReturnValue(promise);
    const { result } = renderHook(() => useSearch(BOARD));

    await act(async () => {
      result.current.search('龍鬚菜');
    });
    act(() => result.current.clear());
    expect(result.current.query).toBe('');
    expect(result.current.status).toEqual({ kind: 'idle' });

    await act(async () => resolve(found([CHAYOTE])));
    expect(result.current.status).toEqual({ kind: 'idle' });
  });

  it('lets a board that arrives mid-search win over the backend answer', async () => {
    // The input is never disabled, so this is the first-visit sequence: type
    // before the board has loaded, miss the empty board, then the board lands
    // with the item — and only then does the backend answer 查無此品項.
    const { promise, resolve } = Promise.withResolvers<ApiResponse>();
    searchProduceMock.mockReturnValue(promise);
    const { result, rerender } = renderHook(({ board }) => useSearch(board), {
      initialProps: { board: [] as ProduceItem[] },
    });

    await act(async () => {
      result.current.search('高麗菜');
    });
    expect(result.current.status).toEqual({ kind: 'searching' });

    rerender({ board: BOARD });
    expect(result.current.status).toEqual({ kind: 'local', items: [CABBAGE] });

    await act(async () => resolve({ error: '查無此品項', items: [] }));
    expect(result.current.status).toEqual({ kind: 'local', items: [CABBAGE] });
  });

  // Each of these used to miss the board and pay for a live backend query for
  // an item the shopper could already see — the whole point of sharing the
  // alias table with the backend (#21).
  it.each([
    ['cabbage', 'an English alias'],
    ['高丽菜', 'the simplified spelling'],
    ['高麗菜多少錢', 'a price question'],
    ['  ＣＡＢＢＡＧＥ ', 'full-width upper case'],
  ])('answers %s (%s) from the board with no request at all', async (query) => {
    const { result } = renderHook(() => useSearch(BOARD));

    await act(async () => result.current.search(query));
    expect(result.current.status).toEqual({ kind: 'local', items: [CABBAGE] });
    expect(searchProduceMock).not.toHaveBeenCalled();
  });

  it('narrows the board while typing, after a pause and without a request', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSearch(BOARD));

    act(() => result.current.preview('高丽'));
    expect(result.current.status).toEqual({ kind: 'idle' }); // mid-word: the board stays whole

    await act(async () => void vi.advanceTimersByTime(300));
    expect(result.current.status).toEqual({ kind: 'local', items: [CABBAGE] });
    expect(searchProduceMock).not.toHaveBeenCalled();
  });

  it('coalesces keystrokes, so only the last one filters', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSearch(BOARD));

    act(() => result.current.preview('高'));
    act(() => void vi.advanceTimersByTime(200));
    act(() => result.current.preview('banana'));
    await act(async () => void vi.advanceTimersByTime(300));

    expect(result.current.status).toEqual({ kind: 'local', items: [BANANA] });
  });

  it('never says 查無此品項 while typing: an unmatched preview leaves the board', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSearch(BOARD));

    act(() => result.current.preview('xyz'));
    await act(async () => void vi.advanceTimersByTime(300));

    expect(result.current.status).toEqual({ kind: 'idle' });
    expect(itemsFor(result.current.status, BOARD)).toBe(BOARD);
    expect(searchProduceMock).not.toHaveBeenCalled();
  });

  it('drops a pending preview on submit, so a stale keystroke cannot wipe the answer', async () => {
    vi.useFakeTimers();
    searchProduceMock.mockResolvedValue(found([CHAYOTE]));
    const { result } = renderHook(() => useSearch(BOARD));

    act(() => result.current.preview('龍鬚菜'));
    await act(async () => result.current.search('龍鬚菜'));
    expect(result.current.status).toEqual({ kind: 'remote', items: [CHAYOTE] });

    await act(async () => void vi.advanceTimersByTime(300));
    expect(result.current.status).toEqual({ kind: 'remote', items: [CHAYOTE] });
  });

  it('lets a keystroke void an answer still in flight, because the box has moved on', async () => {
    vi.useFakeTimers();
    const { promise, resolve } = Promise.withResolvers<ApiResponse>();
    searchProduceMock.mockReturnValue(promise);
    const { result } = renderHook(() => useSearch(BOARD));

    await act(async () => {
      result.current.search('龍鬚菜');
    });
    expect(result.current.status).toEqual({ kind: 'searching' });

    act(() => result.current.preview('龍鬚'));
    await act(async () => void vi.advanceTimersByTime(300));
    await act(async () => resolve(found([CHAYOTE])));

    expect(result.current.query).toBe('龍鬚');
    expect(result.current.status).toEqual({ kind: 'idle' });
  });
});

describe('itemsFor', () => {
  it('keeps the board on screen while there is no answer to show', () => {
    expect(itemsFor({ kind: 'idle' }, BOARD)).toBe(BOARD);
    expect(itemsFor({ kind: 'searching' }, BOARD)).toBe(BOARD);
  });

  it('shows the matched rows once there are any', () => {
    expect(itemsFor({ kind: 'local', items: [CABBAGE] }, BOARD)).toEqual([CABBAGE]);
    expect(itemsFor({ kind: 'remote', items: [CHAYOTE] }, BOARD)).toEqual([CHAYOTE]);
  });

  it('shows nothing once the backend has answered "nothing"', () => {
    const settled: SearchStatus[] = [{ kind: 'not_found' }, { kind: 'transient', message: '服務忙碌中' }];
    for (const status of settled) expect(itemsFor(status, BOARD)).toEqual([]);
  });
});
