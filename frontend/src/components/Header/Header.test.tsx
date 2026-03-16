import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Header from './Header';

describe('Header', () => {
  it('renders the Header component', () => {
    render(<Header />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('contains a search input field', () => {
    render(<Header />);
    expect(screen.getByPlaceholderText('搜尋蔬果...')).toBeInTheDocument();
  });
});
