import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ProduceFilter from './ProduceFilter';

const mockFilterOptions = [
  { label: '全部', value: 'all' },
  { label: '葉菜類', value: '葉菜類' },
  { label: '根莖類', value: '根莖類' },
  { label: '水果', value: '水果' },
];

describe('ProduceFilter', () => {
  it('renders the ProduceFilter component with all options', () => {
    render(<ProduceFilter options={mockFilterOptions} activeFilter="all" onFilterChange={() => {}} />);

    mockFilterOptions.forEach(option => {
      expect(screen.getByRole('button', { name: option.label })).toBeInTheDocument();
    });
  });

  it('highlights the active filter option', () => {
    render(<ProduceFilter options={mockFilterOptions} activeFilter="葉菜類" onFilterChange={() => {}} />);

    expect(screen.getByRole('button', { name: '葉菜類' })).toHaveClass('text-ink');
    expect(screen.getByRole('button', { name: '全部' })).not.toHaveClass('text-ink');
  });

  it('calls onFilterChange with the correct value when an option is clicked', () => {
    const handleFilterChange = vi.fn();
    render(<ProduceFilter options={mockFilterOptions} activeFilter="all" onFilterChange={handleFilterChange} />);

    fireEvent.click(screen.getByRole('button', { name: '根莖類' }));
    expect(handleFilterChange).toHaveBeenCalledTimes(1);
    expect(handleFilterChange).toHaveBeenCalledWith('根莖類');
  });
});
