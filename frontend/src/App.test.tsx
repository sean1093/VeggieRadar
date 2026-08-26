import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import App from './App';

// No VITE_API_BASE_URL in tests → api falls back to the bundled MOCK_BOARD.
describe('App (board-first)', () => {
  it('loads the daily board on mount with a data date', async () => {
    render(<App />);
    expect(await screen.findByText('高麗菜')).toBeInTheDocument();
    expect(screen.getAllByText(/今日菜價/).length).toBeGreaterThan(0);
    expect(screen.getByText(/資料日期 2026-08-26/)).toBeInTheDocument();
    // Prices shown in 元/台斤 for grandmas.
    expect(screen.getAllByText(/元\/台斤/).length).toBeGreaterThan(0);
  });

  it('filters the board by category', async () => {
    render(<App />);
    await screen.findByText('高麗菜');
    fireEvent.click(screen.getByRole('button', { name: '水果' }));
    await waitFor(() => expect(screen.queryByText('高麗菜')).not.toBeInTheDocument());
    expect(screen.getByText('香蕉')).toBeInTheDocument();
  });

  it('searches within the board locally', async () => {
    render(<App />);
    await screen.findByText('高麗菜');
    fireEvent.change(screen.getByPlaceholderText(/搜尋蔬果/), { target: { value: '番茄' } });
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));
    await waitFor(() => expect(screen.getByText(/搜尋「/)).toBeInTheDocument());
    expect(within(screen.getByTestId('produce-list')).getByText('番茄')).toBeInTheDocument();
    expect(screen.queryByText('高麗菜')).not.toBeInTheDocument();
  });

  it('stars an item and filters to the watch tab', async () => {
    localStorage.clear();
    render(<App />);
    await screen.findByText('高麗菜');
    fireEvent.click(screen.getByRole('button', { name: '關注 高麗菜' }));
    fireEvent.click(screen.getByRole('button', { name: /★ 關注/ }));
    const list = screen.getByTestId('produce-list');
    expect(within(list).getByText('高麗菜')).toBeInTheDocument();
    expect(within(list).queryByText('香蕉')).not.toBeInTheDocument();
  });
});
