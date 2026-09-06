import { useCallback, useMemo, useState } from 'react';
import { track } from '../lib/analytics';
import { byValueFirst } from '../lib/utils/value-sort';
import type { ProduceItem } from '../types/produce';

export type SortMode = 'category' | 'value';

export interface FilterOption {
  label: string;
  value: string;
}

/** The watchlist slice the board view needs: the ★ tab's label and its filter. */
export interface WatchlistFilter {
  count: number;
  isWatched: (officialName: string) => boolean;
}

export interface BoardView {
  /** Rows to render: the base items after the active filter and sort. */
  visibleItems: ProduceItem[];
  filterOptions: FilterOption[];
  activeFilter: string;
  changeFilter: (value: string) => void;
  resetFilter: () => void;
  /** Whether any row carries a baseline — the 划算優先 toggle is meaningless without one. */
  hasBaselines: boolean;
  sortMode: SortMode;
  toggleSort: () => void;
  selectedItem: ProduceItem | null;
  select: (item: ProduceItem) => void;
  close: () => void;
}

const SORT_KEY = 'veggieradar_sort_v1';

/**
 * How the board is presented: which rows, in what order, and which one the
 * drawer is showing. It is the single place #19's deep links will have to
 * synchronise the URL with.
 */
export function useBoardView(baseItems: ProduceItem[], watchlist: WatchlistFilter): BoardView {
  // Board order. 'category' is the curated definition order; 'value' puts the
  // items furthest below their own monthly baseline first — the "just show me
  // what is worth buying" mode for standing at the market. Persisted so the
  // choice survives the daily revisit.
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    try {
      return localStorage.getItem(SORT_KEY) === 'value' ? 'value' : 'category';
    } catch {
      return 'category';
    }
  });
  const [activeFilter, setActiveFilter] = useState('all');
  const [selectedItem, setSelectedItem] = useState<ProduceItem | null>(null);
  const { count, isWatched } = watchlist;

  const toggleSort = useCallback(() => {
    const mode: SortMode = sortMode === 'value' ? 'category' : 'value';
    setSortMode(mode);
    track('sort_changed', { mode });
    try {
      localStorage.setItem(SORT_KEY, mode);
    } catch {
      // Private mode — keep the in-memory choice.
    }
  }, [sortMode]);

  const changeFilter = useCallback((value: string) => {
    setActiveFilter(value);
    track('filter_changed', { filter: value });
  }, []);

  // A new search widens the board back to 全部. That is a reset, not a choice,
  // so it is deliberately not reported as filter_changed.
  const resetFilter = useCallback(() => setActiveFilter('all'), []);

  const select = useCallback((item: ProduceItem) => setSelectedItem(item), []);
  const close = useCallback(() => setSelectedItem(null), []);

  const filterOptions = useMemo<FilterOption[]>(() => {
    const cats = Array.from(new Set(baseItems.map((it) => it.category)));
    return [
      { label: count > 0 ? `★ 關注 ${count}` : '★ 關注', value: 'watch' },
      { label: '全部', value: 'all' },
      ...cats.map((c) => ({ label: c, value: c })),
    ];
  }, [baseItems, count]);

  const visibleItems = useMemo(() => {
    let items = baseItems;
    if (activeFilter === 'watch') items = items.filter((it) => isWatched(it.official_name));
    else if (activeFilter !== 'all') items = items.filter((it) => it.category === activeFilter);
    if (sortMode === 'value') {
      // Stable sort; items without a finite baseline sink to the bottom in
      // their original curated order rather than pretending to be ranked.
      items = [...items].sort(byValueFirst);
    }
    return items;
  }, [baseItems, activeFilter, isWatched, sortMode]);

  const hasBaselines = useMemo(
    () => baseItems.some((it) => Number.isFinite(it.vs_baseline_percent)),
    [baseItems],
  );

  return {
    visibleItems,
    filterOptions,
    activeFilter,
    changeFilter,
    resetFilter,
    hasBaselines,
    sortMode,
    toggleSort,
    selectedItem,
    select,
    close,
  };
}
