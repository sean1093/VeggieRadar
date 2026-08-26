import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ProduceList from './ProduceList';
import type { ProduceItem } from '../../types/produce';

const items: ProduceItem[] = [
  { code: 'LA', name: '高麗菜', official_name: '甘藍', category: '葉菜類', avg_price: 24.4, catty_price: 14.6, change_percent: -3.1, trade_volume: 416301, unit: '公斤', markets_count: 6 },
  { code: 'SA', name: '蔥', official_name: '蔥', category: '辛香類', avg_price: 58.3, catty_price: 35.0, change_percent: 25.7, trade_volume: 77610, unit: '公斤', markets_count: 6 },
];

describe('ProduceList', () => {
  it('renders a card per item', () => {
    render(<ProduceList items={items} onCardClick={vi.fn()} />);
    expect(screen.getByTestId('produce-list')).toBeInTheDocument();
    expect(screen.getByText('高麗菜')).toBeInTheDocument();
    expect(screen.getByText('蔥')).toBeInTheDocument();
  });

  it('renders skeletons while loading', () => {
    const { container } = render(<ProduceList items={[]} loading onCardClick={vi.fn()} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders nothing when empty (parent shows empty state)', () => {
    const { container } = render(<ProduceList items={[]} onCardClick={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
