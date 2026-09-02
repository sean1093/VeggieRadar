import { useEffect, useMemo, useState } from 'react';
import Header from './components/Header/Header';
import ProduceList from './components/ProduceGrid/ProduceList';
import ProduceFilter from './components/ProduceFilter/ProduceFilter';
import DetailDrawer from './components/DetailDrawer/DetailDrawer';
import EmptyState from './components/EmptyState/EmptyState';
import ErrorMessage from './components/ErrorMessage/ErrorMessage';
import { fetchBoard, readCachedBoard, searchProduce } from './services/api';
import { useWatchlist } from './hooks/useWatchlist';
import { describeFreshness, type FreshnessNotice } from './lib/utils/freshness';
import { isApiError, type BoardResponse, type ProduceItem } from './types/produce';
import './App.css';

function App() {
  const [board, setBoard] = useState<ProduceItem[]>([]);
  const [boardDate, setBoardDate] = useState('');
  const [freshness, setFreshness] = useState<FreshnessNotice>({ note: null, checkedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Set when the backend is unreachable and the board on screen came from the
  // localStorage fallback — old prices beat a blank page, but must say so.
  const [connectionNote, setConnectionNote] = useState<string | null>(null);
  // Transport-level search failure. Kept apart from empty results so a busy
  // backend is never presented as 查無此品項.
  const [searchError, setSearchError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [remoteResults, setRemoteResults] = useState<ProduceItem[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [activeFilter, setActiveFilter] = useState('all');
  const [selectedItem, setSelectedItem] = useState<ProduceItem | null>(null);
  const { count: watchCount, isWatched, toggle } = useWatchlist();
  const toggleWatch = (item: ProduceItem) => toggle(item.official_name);

  const applyBoard = (res: BoardResponse) => {
    setBoard(res.items);
    setBoardDate(res.date);
    setFreshness(describeFreshness({ date: res.date, generatedAt: res.generated_at, stale: res.stale }));
  };

  const loadBoard = () => {
    // Paint the last good board immediately and refresh in the background, so
    // a slow or over-quota backend never holds the UI on a skeleton.
    const cached = readCachedBoard();
    if (cached) {
      applyBoard(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    setConnectionNote(null);
    fetchBoard().then((res) => {
      if (isApiError(res)) {
        if (cached) {
          setConnectionNote('目前連不上伺服器，顯示上次成功載入的行情');
        } else {
          setError(res.error);
          setBoard([]);
        }
      } else if (res.type === 'board') {
        applyBoard(res);
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
    setSearchError(null);
    setActiveFilter('all');
    if (!q) return;

    const ql = q.toLowerCase();
    const localHit = board.some(
      (it) => it.name.toLowerCase().includes(ql) || it.official_name.includes(q),
    );
    if (localHit) return;

    setSearching(true);
    const res = await searchProduce(q);
    if (isApiError(res)) {
      if (res.transient) setSearchError(res.error);
      setRemoteResults([]);
    } else {
      setRemoteResults(res.items);
    }
    setSearching(false);
  };

  const clearSearch = () => {
    setQuery('');
    setRemoteResults(null);
    setSearchError(null);
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
              <p className="mt-1 text-sm text-stone">
                資料日期 {boardDate}・批發市場收盤均價
                {freshness.checkedAt && <span className="text-stone">・更新於 {freshness.checkedAt}</span>}
              </p>
            )}
            {freshness.note && <p className="mt-1 text-xs text-clay">{freshness.note}</p>}
            {connectionNote && (
              <p className="mt-1 text-xs text-clay">
                {connectionNote}
                <button onClick={loadBoard} className="ml-2 underline underline-offset-2">
                  重試
                </button>
              </p>
            )}
            <p className="mt-1 text-xs text-stone">
              價格以每台斤（600&nbsp;克）計。<span className="text-sage">↓ 便宜</span>・<span className="text-clay">↑ 變貴</span>
            </p>
            <p className="mt-1 text-xs text-stone">
              大字為傳統市場零售推估（批發價加攤販常見加成），非實際報價；漲跌以批發價計。
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
            {!busy && searchError && (
              <ErrorMessage error={searchError} query={query} onRetry={() => handleSearch(query)} />
            )}

            {!busy && !searchError && visibleItems.length === 0 && activeFilter === 'watch' && (
              <EmptyState message="還沒有關注的品項" suggestion="點卡片左側的 ☆ 加入關注，方便每天追蹤。" />
            )}

            {!busy && !searchError && visibleItems.length === 0 && activeFilter !== 'watch' && (
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
