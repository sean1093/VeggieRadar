import React from 'react';
import ProduceCard from '../ProduceCard/ProduceCard'; // Import ProduceCard

interface ProduceItem {
  code: string;
  name: string;
  avg_price: number;
  change_percent: number;
  trend: number[];
  category: string;
}

interface ProduceGridProps {
  items?: ProduceItem[];
  loading?: boolean;
}

const ProduceGrid: React.FC<ProduceGridProps> = ({ items, loading = true }) => {
  if (loading) {
    return <div data-testid="produce-grid">載入中...</div>;
  }

  if (!items || items.length === 0) {
    return <div data-testid="produce-grid">目前沒有蔬果資訊。</div>;
  }

  return (
    <div data-testid="produce-grid" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
      {items.map((item) => (
        <ProduceCard key={item.code} item={item} />
      ))}
    </div>
  );
};

export default ProduceGrid;
