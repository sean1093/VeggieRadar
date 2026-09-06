import Header from './components/Header/Header';
import BoardCaption from './components/BoardCaption/BoardCaption';
import ProduceList from './components/ProduceGrid/ProduceList';
import ProduceFilter from './components/ProduceFilter/ProduceFilter';
import DetailDrawer from './components/DetailDrawer/DetailDrawer';
import EmptyState from './components/EmptyState/EmptyState';
import ErrorMessage from './components/ErrorMessage/ErrorMessage';
import { boardItems, useBoard } from './hooks/useBoard';
import { itemsFor, useSearch } from './hooks/useSearch';
import { useBoardView } from './hooks/useBoardView';
import { useWatchlist } from './hooks/useWatchlist';
import type { ProduceItem } from './types/produce';
import './App.css';

/**
 * Composition only. Three hooks own the state — the board lifecycle, the
 * query, and how the board is presented — and each exposes a discriminated
 * status, so this file never has to spell out which combination of booleans
 * means what.
 */
function App() {
  const { status, freshness, reload } = useBoard();
  const board = boardItems(status);
  const search = useSearch(board);
  const watchlist = useWatchlist();
  const view = useBoardView(itemsFor(search.status, board), watchlist);
  const searching = search.status.kind === 'searching';
  const toggleWatch = (item: ProduceItem) => watchlist.toggle(item.official_name);

  return (
    <div className="min-h-[100dvh] bg-paper">
      {/* A new query widens the board back to 全部 before it runs. */}
      <Header onSearch={(q) => { view.resetFilter(); search.search(q); }} onClear={search.clear} searching={searching} />

      <main className="mx-auto max-w-2xl px-4 pb-[env(safe-area-inset-bottom)]">
        {status.kind === 'error' ? (
          <ErrorMessage error={status.message} query={search.query} onRetry={reload} />
        ) : (
          <>
            <BoardCaption
              title={search.query ? `搜尋「${search.query}」` : '今日菜價'}
              date={status.kind === 'loading' ? '' : status.board.date}
              freshness={freshness}
              degradedReason={status.kind === 'degraded' ? status.reason : null}
              onRetry={reload}
              searching={searching}
            />

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

            {status.kind === 'loading' && <ProduceList items={[]} loading onCardClick={view.select} />}

            {view.visibleItems.length > 0 && (
              <ProduceList
                items={view.visibleItems}
                onCardClick={view.select}
                isWatched={watchlist.isWatched}
                onToggleWatch={toggleWatch}
              />
            )}

            {search.status.kind === 'transient' && (
              <ErrorMessage error={search.status.message} query={search.query} onRetry={() => search.search(search.query)} />
            )}

            {status.kind !== 'loading' &&
              search.status.kind !== 'transient' &&
              view.visibleItems.length === 0 &&
              (view.activeFilter === 'watch' ? (
                <EmptyState message="還沒有關注的品項" suggestion="點卡片左側的 ☆ 加入關注，方便每天追蹤。" />
              ) : (
                <EmptyState
                  message="查無此品項"
                  suggestion={search.query ? `找不到「${search.query}」，試試：高麗菜、番茄、蔥。` : '目前沒有菜價資料。'}
                />
              ))}

            <p className="py-8 text-center text-xs text-stone">
              資料來源：農業部批發市場交易行情開放資料
            </p>
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
