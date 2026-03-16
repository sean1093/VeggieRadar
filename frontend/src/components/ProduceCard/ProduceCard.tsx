import React from 'react';
import type { ProduceItem } from '../../types/produce';

interface ProduceCardProps {
  item: ProduceItem;
  onClick: (item: ProduceItem) => void;
}

const ProduceCard: React.FC<ProduceCardProps> = ({ item, onClick }) => {
  const changeColorClass = item.change_percent < 0 ? 'text-green-500' : 'text-red-500';
  const changeIcon = item.change_percent < 0 ? '↓' : '↑';

  return (
    <div
      className="border p-4 rounded-lg shadow-md bg-white hover:shadow-lg transition-shadow duration-200 cursor-pointer"
      onClick={() => onClick(item)}
    >
      <h3 className="font-bold text-2xl mb-2 text-gray-800">{item.name}</h3>
      <p className="text-gray-600 text-xl mb-1">
        今日均價: <span className="font-semibold text-2xl">${item.avg_price.toFixed(1)}</span>
        <span className="text-sm ml-1">/{item.unit}</span>
      </p>
      <p className={`text-lg font-semibold ${changeColorClass} mb-2`}>
        {changeIcon} {Math.abs(item.change_percent).toFixed(1)}%
      </p>
      <div className="text-sm text-gray-500 space-y-1">
        <p>產地: {item.origin || '未提供'}</p>
        <p>市場: {item.market}</p>
      </div>
    </div>
  );
};

export default ProduceCard;
