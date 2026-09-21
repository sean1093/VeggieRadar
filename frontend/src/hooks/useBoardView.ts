import { useCallback, useEffect, useMemo, useState } from 'react';
import { track } from '../lib/analytics';
import { closeDrawerUrl, pushUrlState, replaceUrlState, useUrlState, type SortMode } from '../lib/urlState';
import { byValueFirst } from '../lib/utils/value-sort';
import type { ProduceItem } from '../types/produce';

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
  /** Whether any row carries a baseline — the 划算優先 toggle is meaningless without one. */
  hasBaselines: boolean;
  sortMode: SortMode;
  toggleSort: () => void;
  selectedItem: ProduceItem | null;
  select: (item: ProduceItem) => void;
  close: () => void;
  /** A new query: put it in the URL and widen the board back to 全部. */
  applyQuery: (query: string) => void;
  /** The query the URL asks for; the search hook is what runs it. */
  linkedQuery: string;
  /** A link named an item today's board does not carry. */
  notice: string | null;
  /**
   * The open item came back from live search rather than off the board, so a
   * share link for it has to carry the query that found it (`itemUrl`).
   */
  selectedFromSearch: boolean;
}

const SORT_KEY = 'veggieradar_sort_v1';

/**
 * How the board is presented: which rows, in what order, and which one the
 * drawer is showing — and the one place where that state and the URL are the
 * same thing. Everything presentational is *derived* from the hash (§1's
 * Shareable principle), so a reload, a pasted link and the back key all land
 * on the same screen without a second copy of the state to keep in step.
 *
 * `board` is passed alongside `baseItems` because a link may name either: a
 * remote search result is not on the board, and a shared board item is not in
 * the search results on screen.
 */
export function useBoardView(
  baseItems: ProduceItem[],
  watchlist: WatchlistFilter,
  board: ProduceItem[],
  /**
   * The URL asks for a query and the search for it has not answered yet. Only
   * the caller can know: this hook sees the query the URL carries, not the
   * hook that runs it. It matters for one link shape — `#/i/<name>?q=<name>`,
   * what a shared live-search result looks like — where judging the item
   * missing before the answer arrives dismisses the drawer the link was for.
   */
  searchPending = false,
): BoardView {
  const url = useUrlState();
  // Board order. 'category' is the curated definition order; 'value' puts the
  // items furthest below their own monthly baseline first — the "just show me
  // what is worth buying" mode for standing at the market. Persisted so the
  // choice survives the daily revisit, and only the default: an explicit
  // `sort=` in the URL wins, so a link can carry the order it was read in.
  const [storedSort, setStoredSort] = useState<SortMode>(() => {
    try {
      return localStorage.getItem(SORT_KEY) === 'value' ? 'value' : 'category';
    } catch {
      return 'category';
    }
  });
  // The name a link asked for that today's board cannot show; see below.
  const [missedItem, setMissedItem] = useState<string | null>(null);
  const { count, isWatched } = watchlist;
  const sortMode = url.sort ?? storedSort;

  const filterOptions = useMemo<FilterOption[]>(() => {
    const cats = Array.from(new Set(baseItems.map((it) => it.category)));
    return [
      { label: count > 0 ? `★ 關注 ${count}` : '★ 關注', value: 'watch' },
      { label: '全部', value: 'all' },
      ...cats.map((c) => ({ label: c, value: c })),
    ];
  }, [baseItems, count]);

  // A filter today's board cannot honour — a category that went out of season
  // since the link was made — would empty the board and read as 查無此品項.
  const activeFilter = filterOptions.some((o) => o.value === url.filter) ? url.filter : 'all';

  const toggleSort = useCallback(() => {
    const mode: SortMode = sortMode === 'value' ? 'category' : 'value';
    replaceUrlState({ sort: mode });
    setStoredSort(mode);
    track('sort_changed', { mode });
    try {
      localStorage.setItem(SORT_KEY, mode);
    } catch {
      // Private mode — the URL and this session still carry the choice.
    }
  }, [sortMode]);

  const changeFilter = useCallback((value: string) => {
    replaceUrlState({ filter: value });
    track('filter_changed', { filter: value });
  }, []);

  const select = useCallback((item: ProduceItem) => pushUrlState({ item: item.name }), []);
  const close = useCallback(() => closeDrawerUrl(), []);

  const selectedItem = useMemo(() => {
    if (!url.item) return null;
    const named = (it: ProduceItem) => it.name === url.item;
    return baseItems.find(named) ?? board.find(named) ?? null;
  }, [url.item, baseItems, board]);

  // On the board or not: what decides whether a share link needs the query.
  // Read off `board` rather than off a flag, because that is the same list the
  // recipient will look in.
  const selectedFromSearch = useMemo(
    () => selectedItem !== null && !board.some((it) => it.name === selectedItem.name),
    [selectedItem, board],
  );

  // Widening the board back to 全部 for a new query is a reset, not a choice,
  // so it is deliberately not reported as filter_changed.
  const applyQuery = useCallback(
    (query: string) => {
      setMissedItem(null);
      // An item nothing can show goes with it. That is the stranded link:
      // `#/i/枇杷?q=秋葵` after a busy backend, with no drawer, no notice and
      // nothing that would ever resolve it, handed out again by the next
      // reload or address-bar share.
      //
      // An item the *board* carries stays. It survives any query, because
      // `selectedItem` falls back to the board, and this runs from the typing
      // preview too — which settles 300 ms late, long enough for a card tapped
      // in between to have opened a drawer this would then close.
      //
      // Being open right now is not the test: a live-search card is on screen
      // and still stranded by the next query, which is how ✕ over one ended
      // up printing 「that crop has no trading data」 about the price it had
      // just been showing.
      const survives = url.item !== null && board.some((it) => it.name === url.item);
      replaceUrlState({ query: query.trim(), filter: 'all', ...(survives ? {} : { item: null }) });
    },
    [url.item, board],
  );

  // A link to a crop that is out of season today must not look like a broken
  // app: name it in one line and put the URL back on the board. Nothing is
  // decided while there are no items to look in, so a shared drawer opens the
  // moment the board lands rather than being dismissed before it arrives.
  //
  // The name is kept because the sentence has to outlive the URL that carried
  // it. Adjusted here rather than in the effect below: React converges on it
  // in the same commit, while a setState inside the effect would render the
  // board once without it first.
  //
  // `searchPending` is the other half of that: a shared live-search result
  // arrives as `#/i/<name>?q=<name>`, and the named crop is in nobody's board
  // by definition. Deciding before the query has answered dismisses the drawer
  // the link exists for and tells the recipient there is no trading data for a
  // price the sender was looking at seconds earlier.
  const missing =
    url.item !== null && selectedItem === null && !searchPending && baseItems.length + board.length > 0;
  //
  // The notice is also answered by the crop simply arriving. A search that
  // failed transiently and then succeeded on retry puts the price on the board
  // without opening any drawer and without touching the query, and a sentence
  // saying there is no trading data, directly above that price, is worse than
  // no sentence at all.
  const missedNowOnScreen =
    missedItem !== null
    && (baseItems.some((it) => it.name === missedItem) || board.some((it) => it.name === missedItem));
  if (missing && missedItem !== url.item) setMissedItem(url.item);
  // Any drawer that does open answers the notice too: the shopper has moved
  // on, whether he tapped a row or followed another link.
  else if (missedItem !== null && (selectedItem !== null || missedNowOnScreen)) setMissedItem(null);
  useEffect(() => {
    if (missing) replaceUrlState({ item: null });
  }, [missing]);

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
    hasBaselines,
    sortMode,
    toggleSort,
    selectedItem,
    select,
    close,
    applyQuery,
    selectedFromSearch,
    linkedQuery: url.query,
    notice: missedItem === null ? null : `「${missedItem}」今日無交易資料`,
  };
}
