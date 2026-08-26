import React from 'react';

interface EmptyStateProps {
  message?: string;
  suggestion?: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({
  message = '目前沒有資料',
  suggestion = '試著搜尋蔬果名稱，例如：高麗菜、番茄、菠菜。',
}) => {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center justify-center px-6 py-20 text-center">
      <p className="text-lg font-medium text-ink">{message}</p>
      <p className="mt-2 max-w-xs text-sm text-stone">{suggestion}</p>
    </div>
  );
};

export default EmptyState;
