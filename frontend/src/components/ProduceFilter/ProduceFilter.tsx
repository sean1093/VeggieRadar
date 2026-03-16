import React from 'react';

interface FilterOption {
  label: string;
  value: string;
}

interface ProduceFilterProps {
  options: FilterOption[];
  activeFilter: string;
  onFilterChange: (filter: string) => void;
}

const ProduceFilter: React.FC<ProduceFilterProps> = ({ options, activeFilter, onFilterChange }) => {
  return (
    <div className="flex space-x-2 p-4 justify-center">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onFilterChange(option.value)}
          className={`px-4 py-2 rounded-md transition-colors duration-200 ${
            activeFilter === option.value
              ? 'bg-blue-500 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
};

export default ProduceFilter;
