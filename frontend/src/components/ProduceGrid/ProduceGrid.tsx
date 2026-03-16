import React from 'react';
import ProduceCard from '../ProduceCard/ProduceCard';
import type { ProduceItem } from '../../types/produce';

interface ProduceGridProps {
  items?: ProduceItem[];
  loading?: boolean;
  onCardClick: (item: ProduceItem) => void;
}

const LoadingSkeleton: React.FC = () => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="border p-4 rounded-lg shadow-md bg-white animate-pulse">
          <div className="h-6 bg-gray-200 rounded mb-2 w-3/4"></div>
          <div className="h-4 bg-gray-200 rounded mb-1 w-1/2"></div>
          <div className="h-4 bg-gray-200 rounded mb-2 w-1/3"></div>
          <div className="h-16 bg-gray-200 rounded"></div>
        </div>
      ))}
    </div>
  );
};

const ProduceGrid: React.FC<ProduceGridProps> = ({ items, loading = false, onCardClick }) => {
  if (loading) {
    return <LoadingSkeleton />;
  }

  if (!items || items.length === 0) {
    return null; // EmptyState will be shown by parent
  }

  return (
    <div data-testid="produce-grid" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
      {items.map((item) => (
        <ProduceCard key={`${item.code}-${item.market}`} item={item} onClick={onCardClick} />
      ))}
    </div>
  );
};

export default ProduceGrid;
