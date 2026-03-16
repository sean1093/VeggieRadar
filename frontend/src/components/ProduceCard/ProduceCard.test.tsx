import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import ProduceCard from './ProduceCard';

const mockProduceItem = {
  code: 'LA1',
  name: '甘藍-改良種',
  avg_price: 25.4,
  change_percent: -12.5,
  trend: [28, 27, 29, 26, 25.4],
  category: '葉菜類',
};

const mockProduceItemUp = {
  code: 'A1',
  name: '番茄-黑柿',
  avg_price: 45.0,
  change_percent: 5.0,
  trend: [42, 43, 44, 46, 45.0],
  category: '果菜類',
};

describe('ProduceCard', () => {
  it('renders the ProduceCard component with correct data', () => {
    render(<ProduceCard item={mockProduceItem} />);

    expect(screen.getByText(mockProduceItem.name)).toBeInTheDocument();
    expect(screen.getByText(`均價: $${mockProduceItem.avg_price}`)).toBeInTheDocument();
    expect(screen.getByText(`漲跌幅: ${mockProduceItem.change_percent}%`)).toBeInTheDocument();
  });

  it('applies green color for negative change_percent (price down)', () => {
    render(<ProduceCard item={mockProduceItem} />);
    const changePercentElement = screen.getByText(`漲跌幅: ${mockProduceItem.change_percent}%`);
    expect(changePercentElement).toHaveClass('text-green-500'); // Assuming green for down
  });

  it('applies red color for positive change_percent (price up)', () => {
    render(<ProduceCard item={mockProduceItemUp} />);
    const changePercentElement = screen.getByText(`漲跌幅: ${mockProduceItemUp.change_percent}%`);
    expect(changePercentElement).toHaveClass('text-red-500'); // Assuming red for up
  });
});
