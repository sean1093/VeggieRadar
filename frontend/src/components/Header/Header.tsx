import React, { useState } from 'react';

interface HeaderProps {
  onSearch: (query: string) => void;
  onClear?: () => void;
  loading?: boolean;
}

const Header: React.FC<HeaderProps> = ({ onSearch, onClear, loading = false }) => {
  const [value, setValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(value.trim());
  };

  const handleClear = () => {
    setValue('');
    onClear?.();
  };

  return (
    <header className="sticky top-0 z-10 border-b border-line bg-paper/85 backdrop-blur-sm">
      <div className="mx-auto max-w-2xl px-4 pt-4 pb-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold tracking-tight text-ink">今日菜價</h1>
          <span className="text-xs text-stone">台灣蔬果批發行情</span>
        </div>

        <form onSubmit={handleSubmit} className="mt-3 flex items-center gap-3 border-b border-line focus-within:border-ink transition-colors">
          <input
            type="search"
            inputMode="search"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="搜尋蔬果（例如：高麗菜、番茄）"
            disabled={loading}
            className="min-w-0 flex-1 bg-transparent py-2 text-base text-ink placeholder:text-stone outline-none disabled:opacity-50"
          />
          {value && (
            <button
              type="button"
              onClick={handleClear}
              aria-label="清除搜尋"
              className="text-stone hover:text-ink text-lg leading-none"
            >
              ×
            </button>
          )}
          <button
            type="submit"
            disabled={loading}
            className="shrink-0 text-sm text-sage hover:text-ink disabled:opacity-50 transition-colors"
          >
            {loading ? '查詢中' : '搜尋'}
          </button>
        </form>
      </div>
    </header>
  );
};

export default Header;
