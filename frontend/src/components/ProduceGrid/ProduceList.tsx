import React from 'react';
import ProduceCard from '../ProduceCard/ProduceCard';
import type { ProduceItem } from '../../types/produce';

interface ProduceListProps {
  items?: ProduceItem[];
  loading?: boolean;
  onCardClick: (item: ProduceItem) => void;
}

const panelClass = 'mx-auto max-w-2xl bg-surface rounded-2xl border border-line overflow-hidden divide-y divide-line';

const LoadingSkeleton: React.FC = () => (
  <div className={panelClass}>
    {Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="px-5 py-4 flex items-center justify-between animate-pulse">
        <div className="space-y-2">
          <div className="h-4 w-24 rounded bg-line" />
          <div className="h-3 w-16 rounded bg-line" />
        </div>
        <div className="h-6 w-20 rounded bg-line" />
      </div>
    ))}
  </div>
);

const ProduceList: React.FC<ProduceListProps> = ({ items, loading = false, onCardClick }) => {
  if (loading) {
    return <LoadingSkeleton />;
  }
  if (!items || items.length === 0) {
    return null; // EmptyState handled by parent
  }
  return (
    <div data-testid="produce-list" className={panelClass}>
      {items.map((item) => (
        <ProduceCard key={`${item.code}-${item.name}`} item={item} onClick={onCardClick} />
      ))}
    </div>
  );
};

export default ProduceList;
