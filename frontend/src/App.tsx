import { useEffect, useMemo, useState } from 'react';
import Header from './components/Header/Header';
import ProduceList from './components/ProduceGrid/ProduceList';
import ProduceFilter from './components/ProduceFilter/ProduceFilter';
import DetailDrawer from './components/DetailDrawer/DetailDrawer';
import EmptyState from './components/EmptyState/EmptyState';
import ErrorMessage from './components/ErrorMessage/ErrorMessage';
import { fetchBoard, searchProduce } from './services/api';
import { isApiError, type ProduceItem } from './types/produce';
import './App.css';

function App() {
  const [board, setBoard] = useState<ProduceItem[]>([]);
  const [boardDate, setBoardDate] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [remoteResults, setRemoteResults] = useState<ProduceItem[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [activeFilter, setActiveFilter] = useState('all');
  const [selectedItem, setSelectedItem] = useState<ProduceItem | null>(null);

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

  // Search: filter the board locally for instant feedback; if nothing matches,
  // fall back to a live backend query.
  const handleSearch = async (raw: string) => {
    const q = raw.trim();
    setQuery(q);
    setRemoteResults(null);
    setActiveFilter('all');
    if (!q) return;

    const localHit = board.some((it) => it.name.includes(q) || it.official_name.includes(q));
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
    const local = board.filter((it) => it.name.includes(query) || it.official_name.includes(query));
    if (local.length) return local;
    return remoteResults ?? [];
  }, [query, board, remoteResults]);

  const filterOptions = useMemo(() => {
    const cats = Array.from(new Set(baseItems.map((it) => it.category)));
    return [{ label: '全部', value: 'all' }, ...cats.map((c) => ({ label: c, value: c }))];
  }, [baseItems]);

  const visibleItems = useMemo(
    () => (activeFilter === 'all' ? baseItems : baseItems.filter((it) => it.category === activeFilter)),
    [baseItems, activeFilter],
  );

  const busy = loading || searching;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header onSearch={handleSearch} onClear={clearSearch} loading={busy} />

      <main className="container mx-auto px-4 py-6">
        {boardDate && !error && (
          <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-base text-gray-700">
              {query ? (
                <>搜尋「<span className="font-semibold">{query}</span>」</>
              ) : (
                <>今日常見菜價</>
              )}
              <span className="ml-2 text-sm text-gray-400">資料日期 {boardDate}（批發市場收盤均價）</span>
            </p>
            <span className="text-xs text-gray-400">價格以「元/台斤」顯示，綠色↓便宜、紅色↑變貴</span>
          </div>
        )}

        {error && <ErrorMessage error={error} query={query} onRetry={loadBoard} />}

        {!error && (
          <>
            {filterOptions.length > 1 && (
              <ProduceFilter options={filterOptions} activeFilter={activeFilter} onFilterChange={setActiveFilter} />
            )}

            {busy && <ProduceList items={[]} loading onCardClick={setSelectedItem} />}

            {!busy && visibleItems.length > 0 && (
              <ProduceList items={visibleItems} onCardClick={setSelectedItem} />
            )}

            {!busy && visibleItems.length === 0 && (
              <EmptyState
                message="查無此品項"
                suggestion={query ? `找不到「${query}」，試試：高麗菜、番茄、蔥` : '目前沒有菜價資料'}
              />
            )}
          </>
        )}
      </main>

      {selectedItem && (
        <DetailDrawer
          isOpen={!!selectedItem}
          onClose={() => setSelectedItem(null)}
          item={selectedItem}
          allProduceItems={board}
        />
      )}
    </div>
  );
}

export default App;
