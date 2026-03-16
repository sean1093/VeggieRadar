import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ProduceCard from './ProduceCard';
import type { ProduceItem } from '../../types/produce';

const mockProduceItem: ProduceItem = {
  code: 'LA1',
  name: '甘藍-改良種',
  avg_price: 25.4,
  change_percent: -12.5,
  category: '葉菜類',
  origin: '台灣高山',
  unit: '公斤',
  trade_volume: 5000,
  market: '台北一市',
  upper_price: 30.0,
  middle_price: 25.4,
  lower_price: 20.0,
};

const mockProduceItemUp: ProduceItem = {
  code: 'A1',
  name: '番茄-黑柿',
  avg_price: 45.0,
  change_percent: 5.0,
  category: '果菜類',
  origin: '雲林',
  unit: '公斤',
  trade_volume: 3000,
  market: '台北二市',
  upper_price: 50.0,
  middle_price: 45.0,
  lower_price: 40.0,
};

describe('ProduceCard', () => {
  it('renders the ProduceCard component with correct data', () => {
    render(<ProduceCard item={mockProduceItem} onClick={vi.fn()} />);

    expect(screen.getByText(mockProduceItem.name)).toBeInTheDocument();
    expect(screen.getByText(/今日均價/)).toBeInTheDocument();
  });

  it('applies green color for negative change_percent (price down)', () => {
    render(<ProduceCard item={mockProduceItem} onClick={vi.fn()} />);
    const changePercentElement = screen.getByText(/12\.5%/);
    expect(changePercentElement).toHaveClass('text-green-500');
  });

  it('applies red color for positive change_percent (price up)', () => {
    render(<ProduceCard item={mockProduceItemUp} onClick={vi.fn()} />);
    const changePercentElement = screen.getByText(/5\.0%/);
    expect(changePercentElement).toHaveClass('text-red-500');
  });
});
