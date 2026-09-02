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

  it('separates the trading date from the refresh time so a stuck date is explainable', async () => {
    render(<App />);
    await screen.findByText('高麗菜');
    // The mock board is stamped as crawled just now, so the old trading date
    // must be explained as a closure — never as a dead refresh pipeline.
    expect(screen.getByText(/更新於 \d{2}\/\d{2} \d{2}:\d{2}/)).toBeInTheDocument();
    expect(screen.getByText('批發市場休市中，顯示最近一次收盤行情')).toBeInTheDocument();
    expect(screen.queryByText(/資料更新中/)).not.toBeInTheDocument();
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
  describe('划算優先 sort', () => {
    const listedNames = () =>
      Array.from(screen.getByTestId('produce-list').querySelectorAll('h3')).map((el) => el.textContent);

    it('orders by discount vs own baseline; items without one sink in curated order', async () => {
      localStorage.clear();
      render(<App />);
      await screen.findByText('高麗菜');

      fireEvent.click(screen.getByRole('button', { name: /排序/ }));

      const names = listedNames();
      expect(names.slice(0, 4)).toEqual(['白蘿蔔', '高麗菜', '大白菜', '小白菜']); // -25.1, -22.3, -2.5, +11.7
      // Everything without a baseline keeps the curated category order below.
      expect(names.indexOf('青江菜')).toBeGreaterThan(3);
      expect(localStorage.getItem('veggieradar_sort_v1')).toBe('value');
    });

    it('restores the persisted choice on the next visit', async () => {
      localStorage.clear();
      localStorage.setItem('veggieradar_sort_v1', 'value');
      render(<App />);
      await screen.findByText('高麗菜');

      expect(screen.getByRole('button', { name: /排序/ })).toHaveAttribute('aria-pressed', 'true');
      expect(listedNames()[0]).toBe('白蘿蔔');
    });

    it('toggles back to the curated category order', async () => {
      localStorage.clear();
      localStorage.setItem('veggieradar_sort_v1', 'value');
      render(<App />);
      await screen.findByText('高麗菜');

      fireEvent.click(screen.getByRole('button', { name: /排序/ }));
      expect(listedNames()[0]).toBe('高麗菜'); // definition order restored
      expect(localStorage.getItem('veggieradar_sort_v1')).toBe('category');
    });
  });
});
