import { useEffect, useMemo, useState } from 'react';
import Header from './components/Header/Header';
import ProduceList from './components/ProduceGrid/ProduceList';
import ProduceFilter from './components/ProduceFilter/ProduceFilter';
import DetailDrawer from './components/DetailDrawer/DetailDrawer';
import EmptyState from './components/EmptyState/EmptyState';
import ErrorMessage from './components/ErrorMessage/ErrorMessage';
import { fetchBoard, searchProduce } from './services/api';
import { useWatchlist } from './hooks/useWatchlist';
import { isApiError, type ProduceItem } from './types/produce';
import './App.css';

function App() {
  const [board, setBoard] = useState<ProduceItem[]>([]);
  const [boardDate, setBoardDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [remoteResults, setRemoteResults] = useState<ProduceItem[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [activeFilter, setActiveFilter] = useState('all');
  const [selectedItem, setSelectedItem] = useState<ProduceItem | null>(null);
  const { count: watchCount, isWatched, toggle } = useWatchlist();
  const toggleWatch = (item: ProduceItem) => toggle(item.official_name);

  const loadBoard = () => {
    setLoading(true);
    setError(null);
    fetchBoard().then((res) => {
      if (isApiError(res)) {
        setError(res.error);
        setBoard([]);
      } else {
        setBoard(res.items);
        if ('date' in res) setBoardDate(res.date);
      }
      setLoading(false);
    });
  };

  useEffect(loadBoard, []);

  // Search: filter the board locally for instant feedback; fall back to a live
  // backend query only when nothing matches locally.
  const handleSearch = async (raw: string) => {
    const q = raw.trim();
    setQuery(q);
    setRemoteResults(null);
    setActiveFilter('all');
    if (!q) return;

    const ql = q.toLowerCase();
    const localHit = board.some(
      (it) => it.name.toLowerCase().includes(ql) || it.official_name.includes(q),
    );
    if (localHit) return;

    setSearching(true);
    const res = await searchProduce(q);
    setRemoteResults(isApiError(res) ? [] : res.items);
    setSearching(false);
  };

  const clearSearch = () => {
    setQuery('');
    setRemoteResults(null);
  };

  const baseItems = useMemo<ProduceItem[]>(() => {
    if (!query) return board;
    const ql = query.toLowerCase();
    const local = board.filter(
      (it) => it.name.toLowerCase().includes(ql) || it.official_name.includes(query),
    );
    if (local.length) return local;
    return remoteResults ?? [];
  }, [query, board, remoteResults]);

  const filterOptions = useMemo(() => {
    const cats = Array.from(new Set(baseItems.map((it) => it.category)));
    return [
      { label: watchCount > 0 ? `★ 關注 ${watchCount}` : '★ 關注', value: 'watch' },
      { label: '全部', value: 'all' },
      ...cats.map((c) => ({ label: c, value: c })),
    ];
  }, [baseItems, watchCount]);

  const visibleItems = useMemo(() => {
    if (activeFilter === 'watch') return baseItems.filter((it) => isWatched(it.official_name));
    if (activeFilter === 'all') return baseItems;
    return baseItems.filter((it) => it.category === activeFilter);
  }, [baseItems, activeFilter, isWatched]);

  const busy = loading || searching;

  return (
    <div className="min-h-[100dvh] bg-paper">
      <Header onSearch={handleSearch} onClear={clearSearch} loading={busy} />

      <main className="mx-auto max-w-2xl px-4 pb-[env(safe-area-inset-bottom)]">
        {!error && (
          <section className="pt-6 pb-5">
            <h2 className="text-2xl font-semibold tracking-tight text-ink">
              {query ? `搜尋「${query}」` : '今日菜價'}
            </h2>
            {boardDate && (
              <p className="mt-1 text-sm text-stone">資料日期 {boardDate}・批發市場收盤均價</p>
            )}
            <p className="mt-1 text-xs text-stone">
              價格以每台斤（600&nbsp;克）計。<span className="text-sage">↓ 便宜</span>・<span className="text-clay">↑ 變貴</span>
            </p>
          </section>
        )}

        {error && <ErrorMessage error={error} query={query} onRetry={loadBoard} />}

        {!error && (
          <>
            {filterOptions.length > 1 && (
              <div className="pb-5">
                <ProduceFilter options={filterOptions} activeFilter={activeFilter} onFilterChange={setActiveFilter} />
              </div>
            )}

            {busy && <ProduceList items={[]} loading onCardClick={setSelectedItem} />}

            {!busy && visibleItems.length > 0 && (
              <ProduceList
                items={visibleItems}
                onCardClick={setSelectedItem}
                isWatched={isWatched}
                onToggleWatch={toggleWatch}
              />
            )}

            {!busy && visibleItems.length === 0 && activeFilter === 'watch' && (
              <EmptyState message="還沒有關注的品項" suggestion="點卡片左側的 ☆ 加入關注，方便每天追蹤。" />
            )}

            {!busy && visibleItems.length === 0 && activeFilter !== 'watch' && (
              <EmptyState
                message="查無此品項"
                suggestion={query ? `找不到「${query}」，試試：高麗菜、番茄、蔥。` : '目前沒有菜價資料。'}
              />
            )}

            <p className="py-8 text-center text-xs text-stone">
              資料來源：農業部批發市場交易行情開放資料
            </p>
          </>
        )}
      </main>
      {selectedItem && (
        <DetailDrawer
          isOpen={!!selectedItem}
          onClose={() => setSelectedItem(null)}
          item={selectedItem}
          allProduceItems={board}
          watched={isWatched(selectedItem.official_name)}
          onToggleWatch={toggleWatch}
        />
      )}
    </div>
  );
}

export default App;
