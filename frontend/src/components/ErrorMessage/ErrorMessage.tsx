import React from 'react';

interface ErrorMessageProps {
  error: string;
  query?: string;
  onRetry?: () => void;
}

const ErrorMessage: React.FC<ErrorMessageProps> = ({ error, query, onRetry }) => {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center justify-center px-6 py-20 text-center">
      <p className="text-lg font-medium text-ink">{error}</p>
      {query && (
        <p className="mt-2 text-sm text-stone">
          搜尋關鍵字：<span className="text-ink">「{query}」</span>
        </p>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-6 rounded-full border border-line px-6 py-2 text-sm text-ink transition-colors hover:bg-sage-soft"
        >
          重新載入
        </button>
      )}
    </div>
  );
};

export default ErrorMessage;
