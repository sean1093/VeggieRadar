import React from 'react';

interface QuickSearchButtonsProps {
  onSearch: (query: string) => void;
}

const popularItems = [
  { name: '高麗菜', emoji: '🥬' },
  { name: '番茄', emoji: '🍅' },
  { name: '小白菜', emoji: '🥗' },
  { name: '馬鈴薯', emoji: '🥔' },
  { name: '蘋果', emoji: '🍎' },
  { name: '香蕉', emoji: '🍌' },
];

const QuickSearchButtons: React.FC<QuickSearchButtonsProps> = ({ onSearch }) => {
  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">熱門搜尋</h3>
      <div className="flex flex-wrap gap-2">
        {popularItems.map((item) => (
          <button
            key={item.name}
            onClick={() => onSearch(item.name)}
            className="px-4 py-2 bg-white border border-gray-300 rounded-full hover:bg-gray-50 hover:border-gray-400 transition-colors text-sm font-medium flex items-center gap-2"
          >
            <span>{item.emoji}</span>
            <span>{item.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default QuickSearchButtons;
