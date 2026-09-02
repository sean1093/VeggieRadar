import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import EmptyState from './EmptyState';

describe('EmptyState', () => {
  it('renders sensible defaults', () => {
    render(<EmptyState />);
    expect(screen.getByText('目前沒有資料')).toBeInTheDocument();
    expect(screen.getByText(/試著搜尋蔬果名稱/)).toBeInTheDocument();
  });

  it('renders a custom message and suggestion', () => {
    render(<EmptyState message="查無此品項" suggestion="試試：高麗菜" />);
    expect(screen.getByText('查無此品項')).toBeInTheDocument();
    expect(screen.getByText('試試：高麗菜')).toBeInTheDocument();
  });
});