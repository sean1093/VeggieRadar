import { render, screen, fireEvent } from '@testing-library/react';
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
    expect(screen.getByPlaceholderText(/搜尋蔬果/)).toBeInTheDocument();
  });
  it('submits the trimmed query', () => {
    const onSearch = vi.fn();
    render(<Header onSearch={onSearch} />);
    fireEvent.change(screen.getByPlaceholderText(/搜尋蔬果/), { target: { value: '  高麗菜  ' } });
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));
    expect(onSearch).toHaveBeenCalledWith('高麗菜');
  });

  it('reports every keystroke untrimmed, so the board can narrow while typing', () => {
    // Raw, and on every change: debouncing and trimming belong to the hook,
    // which is what decides when a keystroke becomes a filter pass.
    const onQueryChange = vi.fn();
    render(<Header onSearch={vi.fn()} onQueryChange={onQueryChange} />);
    const input = screen.getByPlaceholderText(/搜尋蔬果/);

    fireEvent.change(input, { target: { value: '高' } });
    fireEvent.change(input, { target: { value: '高麗 ' } });
    expect(onQueryChange.mock.calls).toEqual([['高'], ['高麗 ']]);
  });

  it('clears the field and notifies the parent via the × button', () => {
    const onClear = vi.fn();
    render(<Header onSearch={vi.fn()} onClear={onClear} />);
    const input = screen.getByPlaceholderText(/搜尋蔬果/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '番茄' } });

    fireEvent.click(screen.getByRole('button', { name: '清除搜尋' }));
    expect(input.value).toBe('');
    expect(onClear).toHaveBeenCalled();
    // The clear button only exists while there is something to clear.
    expect(screen.queryByRole('button', { name: '清除搜尋' })).not.toBeInTheDocument();
  });

  it('keeps the field typeable while a query is in flight — only the submit button waits', () => {
    render(<Header onSearch={vi.fn()} searching />);
    const input = screen.getByPlaceholderText(/搜尋蔬果/) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '番茄' } });
    expect(input).toBeEnabled();
    expect(input.value).toBe('番茄');
    expect(screen.getByRole('button', { name: '查詢中' })).toBeDisabled();
  });
});
