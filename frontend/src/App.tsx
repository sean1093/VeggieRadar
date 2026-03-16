import { useState } from 'react';
import Header from './components/Header/Header';
import ProduceGrid from './components/ProduceGrid/ProduceGrid';
import ProduceFilter from './components/ProduceFilter/ProduceFilter';
import DetailDrawer from './components/DetailDrawer/DetailDrawer';
import EmptyState from './components/EmptyState/EmptyState';
import ErrorMessage from './components/ErrorMessage/ErrorMessage';
import QuickSearchButtons from './components/QuickSearchButtons/QuickSearchButtons';
import { searchProduce } from './services/api';
import { isApiError, type ProduceItem } from './types/produce';
import './App.css';

const filterOptions = [
  { label: '全部', value: 'all' },
  { label: '葉菜類', value: '葉菜類' },
  { label: '根莖類', value: '根莖類' },
  { label: '水果', value: '水果' },
  { label: '果菜類', value: '果菜類' },
];

function App() {
  const [produceItems, setProduceItems] = useState<ProduceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeFilter, setActiveFilter] = useState('all');
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedProduceItem, setSelectedProduceItem] = useState<ProduceItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState<string>('');
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = async (query: string) => {
    setLoading(true);
    setError(null);
    setLastQuery(query);
    setHasSearched(true);
    setActiveFilter('all'); // Reset filter when new search

    try {
      const response = await searchProduce(query);

      if (isApiError(response)) {
        setError(response.error);
        setProduceItems([]);
      } else {
        setProduceItems(response.items);
        setError(null);
      }
    } catch (err) {
      setError('發生未預期的錯誤，請稍後再試');
      setProduceItems([]);
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = () => {
    setError(null);
    setHasSearched(false);
    setProduceItems([]);
  };

  const filteredItems = produceItems.filter(item => {
    if (activeFilter === 'all') {
      return true;
    }
    return item.category === activeFilter;
  });

  const handleCardClick = (item: ProduceItem) => {
    setSelectedProduceItem(item);
    setIsDrawerOpen(true);
  };

  const handleCloseDrawer = () => {
    setIsDrawerOpen(false);
    setSelectedProduceItem(null);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header onSearch={handleSearch} loading={loading} />

      <main className="container mx-auto px-4 py-6">
        {!hasSearched && (
          <>
            <QuickSearchButtons onSearch={handleSearch} />
            <EmptyState />
          </>
        )}

        {hasSearched && !error && !loading && produceItems.length > 0 && (
          <>
            <div className="mb-4">
              <p className="text-sm text-gray-600">
                搜尋「<span className="font-semibold">{lastQuery}</span>」共找到 {produceItems.length} 個品項
              </p>
            </div>
            <ProduceFilter
              options={filterOptions}
              activeFilter={activeFilter}
              onFilterChange={setActiveFilter}
            />
            <ProduceGrid items={filteredItems} loading={loading} onCardClick={handleCardClick} />
          </>
        )}

        {loading && <ProduceGrid items={[]} loading={true} onCardClick={handleCardClick} />}

        {hasSearched && !loading && !error && produceItems.length === 0 && (
          <EmptyState
            message="查無此品項"
            suggestion={`找不到「${lastQuery}」相關的蔬果，請試試其他關鍵字`}
          />
        )}

        {error && <ErrorMessage error={error} query={lastQuery} onRetry={handleRetry} />}
      </main>

      {selectedProduceItem && (
        <DetailDrawer
          isOpen={isDrawerOpen}
          onClose={handleCloseDrawer}
          item={selectedProduceItem}
          allProduceItems={produceItems}
        />
      )}
    </div>
  );
}

export default App;
