import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useBoardView, type WatchlistFilter } from './useBoardView';
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

describe('useBoardView', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('offers the watch tab, 全部 and only the categories on the board', () => {
    const { result } = renderHook(() => useBoardView(BOARD, { count: 2, isWatched: () => false }));

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
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY));
    expect(result.current.filterOptions[0]).toEqual({ label: '★ 關注', value: 'watch' });
  });

  it('filters by category and reports the choice', () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY));

    act(() => result.current.changeFilter('葉菜類'));
    expect(result.current.activeFilter).toBe('葉菜類');
    expect(names(result.current.visibleItems)).toEqual(['高麗菜', '青江菜']);
    expect(gtag).toHaveBeenCalledWith('event', 'filter_changed', { filter: '葉菜類' });
  });

  it('filters to the watchlist', () => {
    const { result } = renderHook(() =>
      useBoardView(BOARD, { count: 1, isWatched: (id) => id === '甘藍' }),
    );

    act(() => result.current.changeFilter('watch'));
    expect(names(result.current.visibleItems)).toEqual(['高麗菜']);
  });

  it('resets the filter for a search without reporting a filter choice', () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY));

    act(() => result.current.changeFilter('水果'));
    act(() => result.current.resetFilter());

    expect(result.current.activeFilter).toBe('all');
    expect(names(result.current.visibleItems)).toEqual(['高麗菜', '白蘿蔔', '青江菜', '香蕉']);
    // The reset is a consequence of searching, not a choice worth counting.
    expect(gtag.mock.calls.filter(([, name]) => name === 'filter_changed')).toHaveLength(1);
  });

  it('orders 划算優先 by the deepest discount, sinking the rows without a baseline', () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY));

    act(() => result.current.toggleSort());

    expect(result.current.sortMode).toBe('value');
    expect(names(result.current.visibleItems)).toEqual(['白蘿蔔', '高麗菜', '香蕉', '青江菜']);
    expect(localStorage.getItem(SORT_KEY)).toBe('value');
    expect(gtag).toHaveBeenCalledWith('event', 'sort_changed', { mode: 'value' });
  });

  it('restores the persisted sort and toggles back to the curated order', () => {
    localStorage.setItem(SORT_KEY, 'value');
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY));
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
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY));

    expect(result.current.sortMode).toBe('category');
    act(() => result.current.toggleSort());
    expect(result.current.sortMode).toBe('value');
  });

  it('reports whether any row carries a baseline at all', () => {
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY));
    expect(result.current.hasBaselines).toBe(true);

    const { result: bare } = renderHook(() => useBoardView([BOKCHOY], NOBODY));
    expect(bare.current.hasBaselines).toBe(false);
  });

  it('holds the row the drawer is showing', () => {
    const { result } = renderHook(() => useBoardView(BOARD, NOBODY));
    expect(result.current.selectedItem).toBeNull();

    act(() => result.current.select(RADISH));
    expect(result.current.selectedItem).toBe(RADISH);

    act(() => result.current.close());
    expect(result.current.selectedItem).toBeNull();
  });
});
