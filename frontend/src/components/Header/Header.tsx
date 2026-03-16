import React from 'react';

const Header: React.FC = () => {
  return (
    <header className="flex items-center justify-between p-4 border-b border-gray-200">
      <h1 className="text-2xl font-bold">VeggieRadar</h1>
      <div className="relative">
        <input
          type="text"
          placeholder="搜尋蔬果..."
          className="pl-8 pr-4 py-2 rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {/* Placeholder for search icon */}
        <svg
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
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
      </div>
    </header>
  );
};

export default Header;
