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
    <div className="no-scrollbar mx-auto max-w-2xl overflow-x-auto">
      <div className="flex min-w-max gap-6 border-b border-line">
        {options.map((option) => {
          const active = activeFilter === option.value;
          return (
            <button
              key={option.value}
              onClick={() => onFilterChange(option.value)}
              className={`relative whitespace-nowrap pb-3 pt-1 text-sm transition-colors ${
                active ? 'text-ink font-medium' : 'text-stone hover:text-ink'
              }`}
            >
              {option.label}
              {active && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-sage" />}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ProduceFilter;
