import React from 'react';

interface ProduceItem {
  code: string;
  name: string;
  avg_price: number;
  change_percent: number;
  trend: number[];
  category: string;
}

interface ProduceCardProps {
  item: ProduceItem;
}

const ProduceCard: React.FC<ProduceCardProps> = ({ item }) => {
  const changeColorClass = item.change_percent < 0 ? 'text-green-500' : 'text-red-500';

  return (
    <div className="border p-4 rounded-lg shadow-md bg-white hover:shadow-lg transition-shadow duration-200">
      <h3 className="font-bold text-xl mb-2 text-gray-800">{item.name}</h3>
      <p className="text-gray-600 text-lg">
        今日均價: <span className="font-semibold">${item.avg_price.toFixed(1)}</span>
      </p>
      <p className={`text-lg ${changeColorClass}`}>
        漲跌幅: <span className="font-semibold">{item.change_percent.toFixed(1)}%</span>
      </p>
      {/* Placeholder for trend chart - will be implemented later */}
      <div className="h-16 bg-gray-100 mt-3 rounded">
        {/* Trend chart would go here */}
      </div>
    </div>
  );
};

export default ProduceCard;
