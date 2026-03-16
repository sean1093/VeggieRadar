import React from 'react';
import ProduceTrendChart from '../ProduceTrendChart/ProduceTrendChart'; // Import ProduceTrendChart

interface ProduceItem {
  code: string;
  name: string;
  avg_price: number;
  change_percent: number;
  trend: number[];
  category: string;
  description: string; // New field
  origin: string;      // New field
  unit: string;        // New field
}

interface ProduceCardProps {
  item: ProduceItem;
  onClick: (item: ProduceItem) => void; // New prop
}

const ProduceCard: React.FC<ProduceCardProps> = ({ item, onClick }) => {
  const changeColorClass = item.change_percent < 0 ? 'text-green-500' : 'text-red-500';

  return (
    <div
      className="border p-4 rounded-lg shadow-md bg-white hover:shadow-lg transition-shadow duration-200 cursor-pointer"
      onClick={() => onClick(item)}
    >
      <h3 className="font-bold text-xl mb-2 text-gray-800">{item.name}</h3>
      <p className="text-gray-600 text-lg">
        今日均價: <span className="font-semibold">${item.avg_price.toFixed(1)}</span>
      </p>
      <p className={`text-lg ${changeColorClass}`}>
        漲跌幅: <span className="font-semibold">{item.change_percent.toFixed(1)}%</span>
      </p>
      <div className="h-16 mt-3"> {/* Removed bg-gray-100 as chart will fill */}
        <ProduceTrendChart trend={item.trend} />
      </div>
    </div>
  );
};

export default ProduceCard;
