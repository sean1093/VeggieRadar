import React, { useState } from 'react';

interface HeaderProps {
  onSearch: (query: string) => void;
  loading?: boolean;
}

const Header: React.FC<HeaderProps> = ({ onSearch, loading = false }) => {
  const [searchValue, setSearchValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchValue.trim()) {
      onSearch(searchValue.trim());
    }
  };

  const handleClear = () => {
    setSearchValue('');
  };

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-10 shadow-sm">
      <div className="container mx-auto px-4 py-4">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <h1 className="text-3xl font-bold text-green-600">🥬 VeggieRadar</h1>
          <form onSubmit={handleSubmit} className="relative w-full md:w-96">
            <input
              type="text"
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              placeholder="搜尋蔬果名稱（如：番茄、高麗菜）"
              disabled={loading}
              className="w-full pl-10 pr-20 py-3 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
              {searchValue && (
                <button
                  type="button"
                  onClick={handleClear}
                  className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md"
                  aria-label="清除搜尋"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              )}
              <button
                type="submit"
                disabled={loading || !searchValue.trim()}
                className="px-4 py-1.5 bg-green-500 text-white rounded-md hover:bg-green-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors text-sm font-medium"
              >
                {loading ? '搜尋中...' : '搜尋'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </header>
  );
};

export default Header;
