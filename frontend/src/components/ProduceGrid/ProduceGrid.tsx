import React from 'react';

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
        <div key={item.code} className="border p-4 rounded-lg shadow">
          <h3 className="font-bold text-lg">{item.name}</h3>
          <p>均價: ${item.avg_price}</p>
          <p>漲跌幅: {item.change_percent}%</p>
          {/* Trend chart placeholder */}
          <div className="h-16 bg-gray-100 mt-2 rounded"></div>
        </div>
      ))}
    </div>
  );
};

export default ProduceGrid;
