import React from 'react';

interface EmptyStateProps {
  message?: string;
  suggestion?: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({
  message = '歡迎使用 VeggieRadar',
  suggestion = '請在上方搜尋框輸入蔬果名稱，例如：番茄、高麗菜、蘋果',
}) => {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] text-center px-4">
      <div className="text-6xl mb-4">🥬</div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">{message}</h2>
      <p className="text-gray-600 max-w-md">{suggestion}</p>
    </div>
  );
};

export default EmptyState;
