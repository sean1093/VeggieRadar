import React from 'react';
import ProduceCard from '../ProduceCard/ProduceCard';
import type { ProduceItem } from '../../types/produce';

interface ProduceListProps {
  items?: ProduceItem[];
  loading?: boolean;
  onCardClick: (item: ProduceItem) => void;
}

const gridClass = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4';

const LoadingSkeleton: React.FC = () => (
  <div className={gridClass}>
    {Array.from({ length: 9 }).map((_, i) => (
      <div key={i} className="bg-white rounded-2xl shadow-sm p-5 border border-gray-100 animate-pulse">
        <div className="h-7 bg-gray-200 rounded w-2/3 mb-4" />
        <div className="h-10 bg-gray-200 rounded w-1/2 mb-2" />
        <div className="h-4 bg-gray-200 rounded w-1/3" />
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
    <div data-testid="produce-list" className={gridClass}>
      {items.map((item) => (
        <ProduceCard key={`${item.code}-${item.name}`} item={item} onClick={onCardClick} />
      ))}
    </div>
  );
};

export default ProduceList;
