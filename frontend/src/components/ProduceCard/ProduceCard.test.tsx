import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ProduceCard from './ProduceCard';
import type { ProduceItem } from '../../types/produce';

const down: ProduceItem = {
  code: 'LA', name: '高麗菜', official_name: '甘藍', category: '葉菜類',
  avg_price: 24.4, catty_price: 14.6, change_percent: -3.1,
  trade_volume: 416301, unit: '公斤', markets_count: 6,
};

const up: ProduceItem = {
  code: 'SA', name: '蔥', official_name: '蔥', category: '辛香類',
  avg_price: 58.3, catty_price: 35.0, change_percent: 25.7,
  trade_volume: 77610, unit: '公斤', markets_count: 6,
};

describe('ProduceCard', () => {
  it('shows the display name and 台斤 price', () => {
    render(<ProduceCard item={down} onClick={vi.fn()} />);
    expect(screen.getByText('高麗菜')).toBeInTheDocument();
    expect(screen.getByText('14.6')).toBeInTheDocument();
    expect(screen.getByText(/元\/台斤/)).toBeInTheDocument();
  });

  it('uses green + 便宜了 when price falls', () => {
    render(<ProduceCard item={down} onClick={vi.fn()} />);
    expect(screen.getByText(/3\.1%/)).toHaveClass('text-green-600');
    expect(screen.getByText('便宜了')).toBeInTheDocument();
  });

  it('uses red + 變貴了 when price rises', () => {
    render(<ProduceCard item={up} onClick={vi.fn()} />);
    expect(screen.getByText(/25\.7%/)).toHaveClass('text-red-600');
    expect(screen.getByText('變貴了')).toBeInTheDocument();
  });

  it('calls onClick with the item when tapped', () => {
    const onClick = vi.fn();
    render(<ProduceCard item={down} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledWith(down);
  });
});
