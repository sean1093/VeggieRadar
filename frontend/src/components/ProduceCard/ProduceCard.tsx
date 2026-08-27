import React from 'react';
import type { ProduceItem } from '../../types/produce';

interface ProduceCardProps {
  item: ProduceItem;
  onClick: (item: ProduceItem) => void;
  watched?: boolean;
  onToggleWatch?: (item: ProduceItem) => void;
}

const ProduceCard: React.FC<ProduceCardProps> = ({ item, onClick, watched = false, onToggleWatch }) => {
  const flat = item.change_percent === 0;
  const down = item.change_percent < 0;
  const tone = flat ? 'text-stone' : down ? 'text-sage' : 'text-clay';
  const arrow = flat ? '→' : down ? '↓' : '↑';
  const label = flat ? '持平' : down ? '便宜了' : '變貴了';
  const hasRetail = item.retail_low != null && item.retail_high != null;

  const open = () => onClick(item);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKeyDown}
      aria-label={`${item.name}，批發每台斤 ${item.catty_price.toFixed(1)} 元，${label}${
        hasRetail ? `，菜市場參考價每台斤 ${item.retail_low} 到 ${item.retail_high} 元` : ''
      }`}
      className="group flex cursor-pointer items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-sage-soft/40 active:bg-sage-soft/60 focus:outline-none focus-visible:bg-sage-soft/40"
    >
      <div className="flex min-w-0 items-center gap-3">
        {onToggleWatch && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleWatch(item);
            }}
            aria-pressed={watched}
            aria-label={watched ? `取消關注 ${item.name}` : `關注 ${item.name}`}
            className={`-m-2 p-2 text-xl leading-none transition-colors ${
              watched ? 'text-sage' : 'text-line hover:text-stone'
            }`}
          >
            {watched ? '★' : '☆'}
          </button>
        )}
        <div className="min-w-0">
          <h3 className="truncate text-lg font-medium tracking-tight text-ink">{item.name}</h3>
          <p className="mt-0.5 text-xs text-stone">{item.category}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-5">
        <div className="text-right">
          <p className="leading-none text-ink">
            <span className="text-2xl font-semibold tabular-nums">{item.catty_price.toFixed(1)}</span>
            <span className="ml-1 text-sm font-normal text-stone">元/台斤</span>
          </p>
          {hasRetail ? (
            <p className="mt-1 text-[11px] text-stone tabular-nums">
              市場約 {item.retail_low}–{item.retail_high}
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-stone tabular-nums">約 {item.avg_price.toFixed(0)} 元/公斤</p>
          )}
        </div>

        <div className={`w-14 text-right ${tone}`}>
          <span className="block text-base font-semibold tabular-nums">
            {arrow} {Math.abs(item.change_percent).toFixed(1)}%
          </span>
          <span className="block text-[11px]">{label}</span>
        </div>
      </div>
    </div>
  );
};

export default ProduceCard;
