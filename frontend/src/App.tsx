import { useEffect, useRef } from 'react';
import Header from './components/Header/Header';
import BoardCaption from './components/BoardCaption/BoardCaption';
import ProduceList from './components/ProduceGrid/ProduceList';
import ProduceFilter from './components/ProduceFilter/ProduceFilter';
import DetailDrawer from './components/DetailDrawer/DetailDrawer';
import EmptyState from './components/EmptyState/EmptyState';
import ErrorMessage from './components/ErrorMessage/ErrorMessage';
import { boardItems, useBoard } from './hooks/useBoard';
import { itemsFor, useSearch, type SearchStatus } from './hooks/useSearch';
import { useBoardView } from './hooks/useBoardView';
import { useWatchlist } from './hooks/useWatchlist';
import type { ProduceItem } from './types/produce';
import './App.css';

/**
 * What to offer when a query found nothing. The backend knows the crop
 * catalogue, so its own line (「試試：」 plus roots one edit from the query, or
 * the day's biggest sellers) beats the fixed trio this used to show; that trio
 * survives only as the answer for an older deploy that sends no suggestion.
 */
function missSuggestion(query: string, status: SearchStatus): string {
  if (!query) return '目前沒有菜價資料。';
  const offered = status.kind === 'not_found' ? status.suggestion : undefined;
  return `找不到「${query}」，${offered ?? '試試：高麗菜、番茄、蔥'}。`;
}

/**
 * Composition only. Three hooks own the state — the board lifecycle, the query,
 * and how the board is presented (which is also the URL, so a link restores the
 * screen); each exposes a discriminated status, so no combination of booleans
 * has to be spelled out here.
 */
function App() {
  const { status, freshness, reload } = useBoard();
  const board = boardItems(status);
  const { query, status: searchStatus, search: runQuery, preview, clear } = useSearch(board);
  const watchlist = useWatchlist();
  const view = useBoardView(itemsFor(searchStatus, board), watchlist, board);
  const searching = searchStatus.kind === 'searching';
  const toggleWatch = (item: ProduceItem) => watchlist.toggle(item.official_name);

  // The URL's query runs itself — on a shared `?q=` and on back/forward alike —
  // but not before there is a board to match against: the instant path needs it.
  //
  // Keyed on the URL *changing*, never on the URL merely differing from the
  // box. Typing updates the box without touching the URL, on purpose, so a
  // difference is the normal state mid-word: re-running the URL's query on it
  // undid every debounced keystroke, which left 「打字即時篩選」 inert, and
  // after a submit it re-applied the previous query while the box showed the
  // new one. Each distinct URL query is therefore adopted exactly once.
  const adoptedQuery = useRef<string | null>(null);
  useEffect(() => {
    if (!board.length) return;
    if (adoptedQuery.current === view.linkedQuery) return;
    const firstAdoption = adoptedQuery.current === null;
    adoptedQuery.current = view.linkedQuery;
    // A first load carrying no `?q=` has nothing to restore, and running the
    // empty query here would discard a word typed while the board arrived.
    if (firstAdoption && !view.linkedQuery) return;
    if (view.linkedQuery !== query) runQuery(view.linkedQuery);
  }, [board.length, view.linkedQuery, query, runQuery]);

  // …and the settled word goes back the other way. `query` only moves once the
  // typing debounce has settled, so this publishes one word rather than one
  // keystroke, and marking it adopted is what keeps the effect above from
  // reading its own write as a link to re-run against the backend.
  //
  // Typing has to reach the URL, not just the box: the URL carries the filter
  // too, so without this a word typed on the ★ 關注 tab was intersected with
  // the watchlist and hid a crop that is on the board, and emptying the box
  // with the keyboard left `?q=` behind for the next reload to restore.
  const { applyQuery } = view;
  useEffect(() => {
    if (adoptedQuery.current === null) return; // nothing adopted yet: the board is still arriving
    if (query === view.linkedQuery) return;
    adoptedQuery.current = query;
    applyQuery(query);
  }, [query, view.linkedQuery, applyQuery]);

  // A word still being typed that matches nothing leaves the whole board on
  // screen on purpose — mid-word it is not a miss yet, only unfinished — so the
  // caption must not announce a search the board does not show.
  const narrowed = query !== '' && searchStatus.kind !== 'idle';

  return (
    <div className="min-h-[100dvh] bg-paper">
      {/* Typing filters the board locally (debounced, never a request); Enter
          widens the board back to 全部, writes the query to the URL and asks
          the backend. */}
      <Header
        onSearch={(q) => { view.applyQuery(q); runQuery(q); }}
        onQueryChange={preview}
        onClear={() => { view.applyQuery(''); clear(); }}
        searching={searching}
      />

      <main className="mx-auto max-w-2xl px-4 pb-[env(safe-area-inset-bottom)]">
        {status.kind === 'error' ? (
          <ErrorMessage error={status.message} query={query} onRetry={reload} />
        ) : (
          <>
            <BoardCaption
              title={narrowed ? `搜尋「${query}」` : '今日菜價'}
              date={status.kind === 'loading' ? '' : status.board.date}
              freshness={freshness}
              degradedReason={status.kind === 'degraded' ? status.reason : null}
              onRetry={reload}
              searching={searching}
            />
            {view.notice && <p role="status" className="-mt-4 pb-5 text-xs text-clay">{view.notice}</p>}

            {view.filterOptions.length > 1 && (
              <div className="pb-5">
                <ProduceFilter options={view.filterOptions} activeFilter={view.activeFilter} onFilterChange={view.changeFilter} />
                {view.hasBaselines && (
                  <div className="mx-auto flex max-w-2xl justify-end pt-2">
                    <button
                      onClick={view.toggleSort}
                      aria-pressed={view.sortMode === 'value'}
                      className="text-xs text-stone transition-colors hover:text-ink"
                    >
                      排序：
                      {view.sortMode === 'value' ? <span className="font-medium text-sage">划算優先</span> : '分類'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* The skeleton stands in for rows that are not there yet, so it
                must not sit above rows that are. The input is never disabled,
                so a query submitted during the first paint can be answered
                before the board itself arrives. */}
            {status.kind === 'loading' && view.visibleItems.length === 0 && (
              <ProduceList items={[]} loading onCardClick={view.select} />
            )}

            {view.visibleItems.length > 0 && (
              <ProduceList
                items={view.visibleItems}
                onCardClick={view.select}
                isWatched={watchlist.isWatched}
                onToggleWatch={toggleWatch}
              />
            )}

            {searchStatus.kind === 'transient' && (
              <ErrorMessage error={searchStatus.message} query={query} onRetry={() => runQuery(query)} />
            )}

            {status.kind !== 'loading' &&
              searchStatus.kind !== 'transient' &&
              view.visibleItems.length === 0 &&
              (view.activeFilter === 'watch' ? (
                <EmptyState message="還沒有關注的品項" suggestion="點卡片左側的 ☆ 加入關注，方便每天追蹤。" />
              ) : (
                <EmptyState message="查無此品項" suggestion={missSuggestion(query, searchStatus)} />
              ))}

            <p className="py-8 text-center text-xs text-stone">資料來源：農業部批發市場交易行情開放資料</p>
          </>
        )}
      </main>
      {view.selectedItem && (
        <DetailDrawer
          isOpen={!!view.selectedItem}
          onClose={view.close}
          item={view.selectedItem}
          allProduceItems={board}
          watched={watchlist.isWatched(view.selectedItem.official_name)}
          onToggleWatch={toggleWatch}
        />
      )}
    </div>
  );
}

export default App;
