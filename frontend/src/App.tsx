import React, { useState, useEffect } from 'react';
import Header from './components/Header/Header';
import ProduceGrid from './components/ProduceGrid/ProduceGrid';
import ProduceFilter from './components/ProduceFilter/ProduceFilter'; // Import ProduceFilter
import './App.css';

// Mock data to simulate API response for now
interface ProduceItem {
  code: string;
  name: string;
  avg_price: number;
  change_percent: number;
  trend: number[];
  category: string;
}

const allProduceItems: ProduceItem[] = [
  { code: "LA1", name: "甘藍-改良種", avg_price: 25.4, change_percent: -12.5, trend: [28, 27, 29, 26, 25.4, 24, 25], category: "葉菜類" },
  { code: "A1", name: "番茄-黑柿", avg_price: 45.0, change_percent: 5.0, trend: [42, 43, 44, 46, 45, 47, 48], category: "果菜類" },
  { code: "P1", name: "蘋果-富士", avg_price: 80.0, change_percent: -2.0, trend: [82, 81, 80, 80, 80, 79, 78], category: "水果" },
  { code: "LA2", name: "小白菜", avg_price: 15.0, change_percent: 3.0, trend: [14, 13, 15, 16, 15, 14, 15], category: "葉菜類" },
  { code: "RA1", name: "馬鈴薯", avg_price: 20.0, change_percent: 0.5, trend: [19, 20, 20, 21, 20, 20, 21], category: "根莖類" },
];

const filterOptions = [
  { label: '全部', value: 'all' },
  { label: '葉菜類', value: '葉菜類' },
  { label: '根莖類', value: '根莖類' },
  { label: '水果', value: '水果' },
  { label: '果菜類', value: '果菜類' }, // Added based on mock data
];


function App() {
  const [produceItems, setProduceItems] = useState<ProduceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('all');

  useEffect(() => {
    // Simulate API fetch
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

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="container mx-auto p-4">
        <ProduceFilter
          options={filterOptions}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
        />
        <ProduceGrid items={filteredItems} loading={loading} />
      </main>
    </div>
  );
}

export default App;
