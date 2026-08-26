import React from 'react';
import type { ProduceItem } from '../../types/produce';

interface ProduceCardProps {
  item: ProduceItem;
  onClick: (item: ProduceItem) => void;
}

const ProduceCard: React.FC<ProduceCardProps> = ({ item, onClick }) => {
  const flat = item.change_percent === 0;
  const down = item.change_percent < 0;
  const tone = flat ? 'text-stone' : down ? 'text-sage' : 'text-clay';
  const arrow = flat ? '→' : down ? '↓' : '↑';
  const label = flat ? '持平' : down ? '便宜了' : '變貴了';

  return (
    <button
      type="button"
      onClick={() => onClick(item)}
      aria-label={`${item.name}，每台斤 ${item.catty_price.toFixed(1)} 元，${label}`}
      className="group w-full text-left px-5 py-4 flex items-center justify-between gap-4 transition-colors hover:bg-sage-soft/40 active:bg-sage-soft/60"
    >
      <div className="min-w-0">
        <h3 className="text-lg font-medium tracking-tight text-ink truncate">{item.name}</h3>
        <p className="mt-0.5 text-xs text-stone">{item.category}</p>
      </div>

      <div className="flex items-center gap-5 shrink-0">
        <div className="text-right">
          <p className="leading-none text-ink">
            <span className="text-2xl font-semibold tabular-nums">{item.catty_price.toFixed(1)}</span>
            <span className="ml-1 text-sm font-normal text-stone">元/台斤</span>
          </p>
          <p className="mt-1 text-[11px] text-stone tabular-nums">
            約 {item.avg_price.toFixed(0)} 元/公斤
          </p>
        </div>

        <div className={`w-14 text-right ${tone}`}>
          <span className="block text-base font-semibold tabular-nums">
            {arrow} {Math.abs(item.change_percent).toFixed(1)}%
          </span>
          <span className="block text-[11px]">{label}</span>
        </div>
      </div>
    </button>
  );
};

export default ProduceCard;
