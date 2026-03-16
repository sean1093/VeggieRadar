import React from 'react';

interface ErrorMessageProps {
  error: string;
  query?: string;
  onRetry?: () => void;
}

const ErrorMessage: React.FC<ErrorMessageProps> = ({ error, query, onRetry }) => {
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] text-center px-4">
      <div className="text-6xl mb-4">😔</div>
      <h2 className="text-2xl font-bold text-gray-800 mb-2">
        {error}
      </h2>
      {query && (
        <p className="text-gray-600 mb-4">
          搜尋關鍵字: <span className="font-semibold">「{query}」</span>
        </p>
      )}
      <div className="space-y-2">
        <p className="text-gray-600">請嘗試以下建議：</p>
        <ul className="text-left text-gray-600 space-y-1">
          <li>• 檢查關鍵字是否正確</li>
          <li>• 使用完整或簡短的名稱（如：番茄、甘藍）</li>
          <li>• 試試常見蔬果（如：高麗菜、小白菜）</li>
        </ul>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-6 px-6 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors"
        >
          重新搜尋
        </button>
      )}
    </div>
  );
};

export default ErrorMessage;
