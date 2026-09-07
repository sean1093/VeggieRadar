import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useBoardView, type WatchlistFilter } from './useBoardView';
import { parseUrlState } from '../lib/urlState';
import type { ProduceItem } from '../types/produce';

const SORT_KEY = 'veggieradar_sort_v1';

function item(
  name: string,
  category: string,
  vsBaseline: number | undefined,
  officialName = name,
): ProduceItem {
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
    vs_baseline_percent: vsBaseline,
  };
}

const CABBAGE = item('高麗菜', '葉菜類', -22.3, '甘藍');
const RADISH = item('白蘿蔔', '根莖類', -25.1, '蘿蔔');
const BOKCHOY = item('青江菜', '葉菜類', undefined, '青江白菜');
const BANANA = item('香蕉', '水果', 11.7);
const BOARD = [CABBAGE, RADISH, BOKCHOY, BANANA];

const NOBODY: WatchlistFilter = { count: 0, isWatched: () => false };
const names = (items: ProduceItem[]) => items.map((it) => it.name);
/** Land the window on a hash the way a pasted link would. */
const at = (hash: string) => window.history.replaceState(null, '', `/VeggieRadar/${hash}`);

describe('useBoardView', () => {
  beforeEach(() => {
    localStorage.clear();
    at('');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    at('');
  });

  it('offers the watch tab, 全部 and only the categories on the board', () => {
    const { result } = renderHook(() =>
      useBoardView(BOARD, { count: 2, isWatched: () => false }, BOARD),
    );

    expect(result.current.filterOptions).toEqual([
      { label: '★ 關注 2', value: 'watch' },
      { label: '全部', value: 'all' },
      { label: '葉菜類', value: '葉菜類' },
      { label: '根莖類', value: '根莖類' },
      { label: '水果', value: '水果' },
    ]);
    expect(result.current.activeFilter).toBe('all');
    expect(names(result.current.visibleItems)).toEqual(['高麗菜', '白蘿蔔', '青江菜', '香蕉']);
  });

  it('drops the watch count from the label when the list is empty', () => {
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));
    expect(result.current.filterOptions[0]).toEqual({ label: '★ 關注', value: 'watch' });
  });

  it('filters by category and reports the choice', () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));

    act(() => result.current.changeFilter('葉菜類'));
    expect(result.current.activeFilter).toBe('葉菜類');
    expect(names(result.current.visibleItems)).toEqual(['高麗菜', '青江菜']);
    expect(gtag).toHaveBeenCalledWith('event', 'filter_changed', { filter: '葉菜類' });
  });

  it('filters to the watchlist', () => {
    const { result } = renderHook(() =>
      useBoardView(BOARD, { count: 1, isWatched: (id) => id === '甘藍' }, BOARD),
    );

    act(() => result.current.changeFilter('watch'));
    expect(names(result.current.visibleItems)).toEqual(['高麗菜']);
  });

  it('resets the filter for a search without reporting a filter choice', () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));

    act(() => result.current.changeFilter('水果'));
    act(() => result.current.applyQuery('蔥'));

    expect(result.current.activeFilter).toBe('all');
    expect(result.current.linkedQuery).toBe('蔥');
    expect(names(result.current.visibleItems)).toEqual(['高麗菜', '白蘿蔔', '青江菜', '香蕉']);
    // The reset is a consequence of searching, not a choice worth counting.
    expect(gtag.mock.calls.filter(([, name]) => name === 'filter_changed')).toHaveLength(1);
  });

  it('orders 划算優先 by the deepest discount, sinking the rows without a baseline', () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));

    act(() => result.current.toggleSort());

    expect(result.current.sortMode).toBe('value');
    expect(names(result.current.visibleItems)).toEqual(['白蘿蔔', '高麗菜', '香蕉', '青江菜']);
    expect(localStorage.getItem(SORT_KEY)).toBe('value');
    expect(gtag).toHaveBeenCalledWith('event', 'sort_changed', { mode: 'value' });
  });

  it('restores the persisted sort and toggles back to the curated order', () => {
    localStorage.setItem(SORT_KEY, 'value');
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));
    expect(result.current.sortMode).toBe('value');

    act(() => result.current.toggleSort());
    expect(result.current.sortMode).toBe('category');
    expect(names(result.current.visibleItems)).toEqual(['高麗菜', '白蘿蔔', '青江菜', '香蕉']);
    expect(localStorage.getItem(SORT_KEY)).toBe('category');
  });

  it('keeps the sort choice in memory when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));

    expect(result.current.sortMode).toBe('category');
    act(() => result.current.toggleSort());
    expect(result.current.sortMode).toBe('value');
  });

  it('reports whether any row carries a baseline at all', () => {
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));
    expect(result.current.hasBaselines).toBe(true);

    const { result: bare } = renderHook(() => useBoardView([BOKCHOY], NOBODY, BOARD));
    expect(bare.current.hasBaselines).toBe(false);
  });

  it('holds the row the drawer is showing', async () => {
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));
    expect(result.current.selectedItem).toBeNull();

    act(() => result.current.select(RADISH));
    expect(result.current.selectedItem).toBe(RADISH);

    // Closing leaves the drawer's history entry; jsdom traverses on a task.
    act(() => result.current.close());
    await waitFor(() => expect(result.current.selectedItem).toBeNull());
  });
});

describe('useBoardView — the URL is the state', () => {
  beforeEach(() => {
    localStorage.clear();
    at('');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    at('');
  });

  it('restores the drawer, the filter, the order and the query from a link', () => {
    at('#/i/白蘿蔔?q=蘿蔔&f=根莖類&sort=value');
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));

    expect(result.current.selectedItem).toBe(RADISH);
    expect(result.current.activeFilter).toBe('根莖類');
    expect(result.current.sortMode).toBe('value');
    expect(result.current.linkedQuery).toBe('蘿蔔');
    expect(result.current.notice).toBeNull();
  });

  it('lets an explicit order in the URL win over the persisted one', () => {
    localStorage.setItem(SORT_KEY, 'value');
    at('#/?sort=category');
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));
    expect(result.current.sortMode).toBe('category');
  });

  it('ignores a filter today’s board cannot honour, rather than emptying it', () => {
    at('#/?f=菇類');
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));

    expect(result.current.activeFilter).toBe('all');
    expect(result.current.visibleItems).toHaveLength(4);
  });

  it('writes the view into the URL — the drawer as an entry, the rest in place', async () => {
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));

    act(() => result.current.changeFilter('水果'));
    expect(window.location.hash).toBe('#/?f=%E6%B0%B4%E6%9E%9C');
    act(() => result.current.toggleSort());
    expect(window.location.hash).toBe('#/?f=%E6%B0%B4%E6%9E%9C&sort=value');

    // Filter and sort rewrote the entry in place; the drawer pushed its own,
    // marked so closing can tell it from a pasted link.
    expect(window.history.state).toBeNull();
    act(() => result.current.select(BANANA));
    expect(window.location.hash).toBe('#/i/%E9%A6%99%E8%95%89?f=%E6%B0%B4%E6%9E%9C&sort=value');
    expect(window.history.state).toEqual({ drawer: true });

    // × is the back key: the drawer's entry is left, not buried under a
    // second board entry that Back would have to climb over.
    const back = vi.spyOn(window.history, 'back');
    act(() => result.current.close());
    expect(back).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(window.location.hash).toBe('#/?f=%E6%B0%B4%E6%9E%9C&sort=value'));
    expect(result.current.selectedItem).toBeNull();
  });

  it('closes a deep-linked drawer in place — there is no entry of ours behind it', () => {
    at('#/i/香蕉');
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));
    expect(result.current.selectedItem).toBe(BANANA);

    const back = vi.spyOn(window.history, 'back');
    const entries = window.history.length;
    act(() => result.current.close());
    expect(back).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/');
    expect(window.history.length).toBe(entries);
    expect(result.current.selectedItem).toBeNull();
  });

  it('follows the back key: the drawer closes and the filter comes back', () => {
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));

    act(() => result.current.changeFilter('水果'));
    act(() => result.current.select(BANANA));
    expect(result.current.selectedItem).toBe(BANANA);

    // What the browser does on back: the popped URL, then the event.
    act(() => {
      at('#/?f=水果');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.selectedItem).toBeNull();
    expect(result.current.activeFilter).toBe('水果');
  });

  it('opens a linked drawer as soon as the board lands, without a notice first', () => {
    at('#/i/高麗菜');
    const { result, rerender } = renderHook(
      ({ items }: { items: ProduceItem[] }) => useBoardView(items, NOBODY, items),
      { initialProps: { items: [] as ProduceItem[] } },
    );

    // Still loading: nothing is known yet, so nothing is claimed or reset.
    expect(result.current.selectedItem).toBeNull();
    expect(result.current.notice).toBeNull();
    expect(parseUrlState(window.location.hash).item).toBe('高麗菜');

    rerender({ items: BOARD });
    expect(result.current.selectedItem).toBe(CABBAGE);
  });

  it('resolves an item a live search returned but the board does not carry', () => {
    const RARE = item('龍鬚菜', '葉菜類', undefined);
    at('#/i/龍鬚菜');
    const { result } = renderHook(() => useBoardView([RARE], NOBODY, BOARD));

    expect(result.current.selectedItem).toBe(RARE);
    expect(result.current.notice).toBeNull();
  });

  it('says an out-of-season link has no data today and returns to the board', () => {
    at('#/i/山藥');
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY, BOARD));

    expect(result.current.notice).toBe('「山藥」今日無交易資料');
    expect(result.current.selectedItem).toBeNull();
    expect(window.location.hash).toBe('#/');

    // The next thing the shopper does clears it; it is an event, not a state.
    act(() => result.current.select(CABBAGE));
    expect(result.current.notice).toBeNull();
  });
});
