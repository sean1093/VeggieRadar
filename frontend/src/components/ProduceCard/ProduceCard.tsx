import React from 'react';
import type { ProduceItem } from '../../types/produce';

interface ProduceCardProps {
  item: ProduceItem;
  onClick: (item: ProduceItem) => void;
}

const ProduceCard: React.FC<ProduceCardProps> = ({ item, onClick }) => {
  const down = item.change_percent < 0;
  const flat = item.change_percent === 0;
  const changeColor = flat ? 'text-gray-500' : down ? 'text-green-600' : 'text-red-600';
  const changeBg = flat ? 'bg-gray-100' : down ? 'bg-green-100' : 'bg-red-100';
  const changeIcon = flat ? '→' : down ? '↓' : '↑';
  const changeLabel = flat ? '持平' : down ? '便宜了' : '變貴了';

  return (
    <button
      type="button"
      onClick={() => onClick(item)}
      aria-label={`${item.name} 每台斤 ${item.catty_price.toFixed(1)} 元，${changeLabel}`}
      className="w-full text-left bg-white rounded-2xl shadow-sm hover:shadow-md active:scale-[0.99] transition-all p-5 flex flex-col gap-3 border border-gray-100"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-bold text-2xl text-gray-900 leading-tight">{item.name}</h3>
        <span className="shrink-0 text-xs text-gray-500 bg-gray-100 rounded-full px-2 py-1">{item.category}</span>
      </div>

      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-baseline gap-1">
            <span className="text-4xl font-extrabold text-gray-900">{item.catty_price.toFixed(1)}</span>
            <span className="text-base text-gray-500">元/台斤</span>
          </div>
          <p className="text-sm text-gray-400 mt-0.5">約 {item.avg_price.toFixed(1)} 元/公斤</p>
        </div>

        <div className={`flex flex-col items-center rounded-xl px-3 py-2 ${changeBg}`}>
          <span className={`text-xl font-bold ${changeColor}`}>
            {changeIcon} {Math.abs(item.change_percent).toFixed(1)}%
          </span>
          <span className={`text-xs font-medium ${changeColor}`}>{changeLabel}</span>
        </div>
      </div>
    </button>
  );
};

export default ProduceCard;
