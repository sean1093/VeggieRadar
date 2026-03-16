import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Header from './Header';

describe('Header', () => {
  const mockOnSearch = vi.fn();

  it('renders the Header component', () => {
    render(<Header onSearch={mockOnSearch} />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('contains a search input field', () => {
    render(<Header onSearch={mockOnSearch} />);
    expect(screen.getByPlaceholderText(/搜尋蔬果名稱/)).toBeInTheDocument();
  });
});
