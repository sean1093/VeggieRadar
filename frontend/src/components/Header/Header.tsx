import React, { useState } from 'react';

interface HeaderProps {
  onSearch: (query: string) => void;
  onClear?: () => void;
  loading?: boolean;
}

const Header: React.FC<HeaderProps> = ({ onSearch, onClear, loading = false }) => {
  const [searchValue, setSearchValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(searchValue.trim());
  };

  const handleClear = () => {
    setSearchValue('');
    onClear?.();
  };

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-10 shadow-sm">
      <div className="container mx-auto px-4 py-4">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <h1 className="text-3xl font-bold text-green-600 whitespace-nowrap">🥬 今日菜價</h1>
          <form onSubmit={handleSubmit} className="relative w-full md:w-[28rem]">
            <input
              type="search"
              inputMode="search"
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder="搜尋蔬果名稱（如：番茄、高麗菜）"
              disabled={loading}
              className="w-full pl-4 pr-24 py-3 text-lg rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent disabled:bg-gray-100"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {searchValue && (
                <button
                  type="button"
                  onClick={handleClear}
                  className="px-2 py-1 text-gray-400 hover:text-gray-600"
                  aria-label="清除搜尋"
                >
                  ✕
                </button>
              )}
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:bg-gray-300 transition-colors font-medium"
              >
                {loading ? '查詢中' : '搜尋'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </header>
  );
};

export default Header;
