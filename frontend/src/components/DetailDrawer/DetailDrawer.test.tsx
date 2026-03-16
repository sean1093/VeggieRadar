import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import DetailDrawer from './DetailDrawer';

const mockProduceItem = {
  code: 'LA1',
  name: '甘藍-改良種',
  avg_price: 25.4,
  change_percent: -12.5,
  trend: [28, 27, 29, 26, 25.4],
  category: '葉菜類',
  // Add more detailed info for the drawer
  description: '新鮮甘藍，富含維生素C，是家常料理的好選擇。',
  origin: '台灣高山',
  unit: '公斤',
};

describe('DetailDrawer', () => {
  it('does not render when isOpen is false', () => {
    render(<DetailDrawer isOpen={false} onClose={() => {}} item={mockProduceItem} />);
    expect(screen.queryByTestId('detail-drawer')).not.toBeInTheDocument();
  });

  it('renders when isOpen is true', () => {
    render(<DetailDrawer isOpen={true} onClose={() => {}} item={mockProduceItem} />);
    expect(screen.getByTestId('detail-drawer')).toBeInTheDocument();
  });

  it('displays the detailed information of the produce item', () => {
    render(<DetailDrawer isOpen={true} onClose={() => {}} item={mockProduceItem} />);
    expect(screen.getByText(mockProduceItem.name)).toBeInTheDocument();
    expect(screen.getByText(`均價: $${mockProduceItem.avg_price}`)).toBeInTheDocument();
    expect(screen.getByText(`分類: ${mockProduceItem.category}`)).toBeInTheDocument();
    expect(screen.getByText(mockProduceItem.description)).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', () => {
    const handleClose = vi.fn();
    render(<DetailDrawer isOpen={true} onClose={handleClose} item={mockProduceItem} />);
    fireEvent.click(screen.getByRole('button', { name: /關閉|close/i })); // Assuming a close button
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
