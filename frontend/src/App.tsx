import React, { useState, useEffect } from 'react';
import Header from './components/Header/Header';
import ProduceGrid from './components/ProduceGrid/ProduceGrid';
import ProduceFilter from './components/ProduceFilter/ProduceFilter';
import DetailDrawer from './components/DetailDrawer/DetailDrawer'; // Import DetailDrawer
import './App.css';

interface ProduceItem {
  code: string;
  name: string;
  avg_price: number;
  change_percent: number;
  trend: number[];
  category: string;
  description: string;
  origin: string;
  unit: string;
}

const allProduceItems: ProduceItem[] = [
  { code: "LA1", name: "甘藍-改良種", avg_price: 25.4, change_percent: -12.5, trend: [28, 27, 29, 26, 25.4, 24, 25], category: "葉菜類", description: "新鮮甘藍，富含維生素C，是家常料理的好選擇。", origin: "台灣高山", unit: "公斤" },
  { code: "A1", name: "番茄-黑柿", avg_price: 45.0, change_percent: 5.0, trend: [42, 43, 44, 46, 45, 47, 48], category: "果菜類", description: "香甜多汁的黑柿番茄，適合生食或烹煮。", origin: "雲林", unit: "公斤" },
  { code: "P1", name: "蘋果-富士", avg_price: 80.0, change_percent: -2.0, trend: [82, 81, 80, 80, 80, 79, 78], category: "水果", description: "清脆香甜的富士蘋果，老少咸宜。", origin: "青森", unit: "公斤" },
  { code: "LA2", name: "小白菜", avg_price: 15.0, change_percent: 3.0, trend: [14, 13, 15, 16, 15, 14, 15], category: "葉菜類", description: "鮮嫩小白菜，快速烹煮即可上桌。", origin: "彰化", unit: "把" },
  { code: "RA1", name: "馬鈴薯", avg_price: 20.0, change_percent: 0.5, trend: [19, 20, 20, 21, 20, 20, 21], category: "根莖類", description: "鬆軟綿密的馬鈴薯，料理用途廣泛。", origin: "嘉義", unit: "公斤" },
];

const filterOptions = [
  { label: '全部', value: 'all' },
  { label: '葉菜類', value: '葉菜類' },
  { label: '根莖類', value: '根莖類' },
  { label: '水果', value: '水果' },
  { label: '果菜類', value: '果菜類' },
];


function App() {
  const [produceItems, setProduceItems] = useState<ProduceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('all');
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedProduceItem, setSelectedProduceItem] = useState<ProduceItem | null>(null);

  useEffect(() => {
    setTimeout(() => {
      setProduceItems(allProduceItems);
      setLoading(false);
    }, 1000);
  }, []);

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
      <Header />
      <main className="container mx-auto p-4">
        <ProduceFilter
          options={filterOptions}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />
        <ProduceGrid items={filteredItems} loading={loading} onCardClick={handleCardClick} />
      </main>

      {selectedProduceItem && (
        <DetailDrawer
          isOpen={isDrawerOpen}
          onClose={handleCloseDrawer}
          item={selectedProduceItem}
        />
      )}
    </div>
  );
}

export default App;