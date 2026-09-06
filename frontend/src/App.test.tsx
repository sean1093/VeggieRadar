import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import App from './App';
import { parseUrlState } from './lib/urlState';

/** Land the window on a hash the way a pasted link would. */
const at = (hash: string) => window.history.replaceState(null, '', `/VeggieRadar/${hash}`);

// A fresh visit is an empty hash and empty storage: the board view lives in
// both, so a leftover would carry one test's filter or query into the next.
beforeEach(() => {
  at('');
  localStorage.clear();
});

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
    render(<App />);
    await screen.findByText('高麗菜');
    fireEvent.click(screen.getByRole('button', { name: '關注 高麗菜' }));
    fireEvent.click(screen.getByRole('button', { name: /★ 關注/ }));
    const list = screen.getByTestId('produce-list');
    expect(within(list).getByText('高麗菜')).toBeInTheDocument();
    expect(within(list).queryByText('香蕉')).not.toBeInTheDocument();
  });
  it('keeps the board on screen during a remote search, then states the miss honestly', async () => {
    render(<App />);
    await screen.findByText('高麗菜');
    fireEvent.change(screen.getByPlaceholderText(/搜尋蔬果/), { target: { value: '龍鬚菜' } });
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));

    // A query in flight is no reason to blank prices a shopper already has,
    // and 查無此品項 must not flash before the backend has answered. Typing
    // stays possible throughout; only the submit button waits.
    expect(screen.getByText('查詢中…')).toBeInTheDocument();
    expect(screen.getByText('高麗菜')).toBeInTheDocument();
    expect(screen.queryByText('查無此品項')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/搜尋蔬果/)).toBeEnabled();

    expect(await screen.findByText('查無此品項')).toBeInTheDocument();
    expect(screen.getByText(/找不到「龍鬚菜」/)).toBeInTheDocument();
  });

  it('clears the search back to the full board', async () => {
    render(<App />);
    await screen.findByText('高麗菜');
    fireEvent.change(screen.getByPlaceholderText(/搜尋蔬果/), { target: { value: '番茄' } });
    fireEvent.click(screen.getByRole('button', { name: '搜尋' }));
    await waitFor(() => expect(screen.queryByText('高麗菜')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '清除搜尋' }));
    expect(await screen.findByText('高麗菜')).toBeInTheDocument();
    expect(screen.getByText('今日菜價', { selector: 'h2' })).toBeInTheDocument();
  });
  describe('划算優先 sort', () => {
    const listedNames = () =>
      Array.from(screen.getByTestId('produce-list').querySelectorAll('h3')).map((el) => el.textContent);

    it('orders by discount vs own baseline; items without one sink in curated order', async () => {
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
      localStorage.setItem('veggieradar_sort_v1', 'value');
      render(<App />);
      await screen.findByText('高麗菜');

      expect(screen.getByRole('button', { name: /排序/ })).toHaveAttribute('aria-pressed', 'true');
      expect(listedNames()[0]).toBe('白蘿蔔');
    });

    it('toggles back to the curated category order', async () => {
      localStorage.setItem('veggieradar_sort_v1', 'value');
      render(<App />);
      await screen.findByText('高麗菜');

      fireEvent.click(screen.getByRole('button', { name: /排序/ }));
      expect(listedNames()[0]).toBe('高麗菜'); // definition order restored
      expect(localStorage.getItem('veggieradar_sort_v1')).toBe('category');
    });
  });
});

describe('App — deep links', () => {
  it('opens the drawer for a linked item, so a reload keeps it open', async () => {
    at('#/i/高麗菜');
    render(<App />);

    const drawer = await screen.findByTestId('detail-drawer');
    expect(within(drawer).getByText('高麗菜')).toBeInTheDocument();
    expect(within(drawer).getByText(/菜市場參考價/)).toBeInTheDocument();
  });

  it('gives the drawer a history entry, so the phone back key closes it', async () => {
    render(<App />);
    await screen.findByText('高麗菜');

    fireEvent.click(screen.getByText('高麗菜'));
    await screen.findByTestId('detail-drawer');
    expect(parseUrlState(window.location.hash).item).toBe('高麗菜');

    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.queryByTestId('detail-drawer')).not.toBeInTheDocument());
    expect(parseUrlState(window.location.hash).item).toBeNull();
    // The board is still there — back closed the drawer, it did not leave.
    expect(screen.getByText('高麗菜')).toBeInTheDocument();
  });

  it('says so and returns to the board when the link names an out-of-season crop', async () => {
    at('#/i/龍鬚菜');
    render(<App />);
    await screen.findByText('高麗菜');

    expect(screen.getByRole('status')).toHaveTextContent('「龍鬚菜」今日無交易資料');
    expect(screen.queryByTestId('detail-drawer')).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#/');
  });

  it('runs a linked search once the board it matches against has landed', async () => {
    at('#/?q=蔥');
    render(<App />);

    expect(await screen.findByText('搜尋「蔥」')).toBeInTheDocument();
    const list = screen.getByTestId('produce-list');
    expect(within(list).getByText('蔥')).toBeInTheDocument();
    expect(within(list).queryByText('高麗菜')).not.toBeInTheDocument();
  });

  it('restores a linked filter and order together', async () => {
    at('#/?f=水果&sort=value');
    render(<App />);
    await screen.findByText('香蕉');

    expect(screen.getByRole('button', { name: '水果' })).toHaveClass('text-ink');
    expect(screen.queryByText('高麗菜')).not.toBeInTheDocument();
    // The order came from the link: nothing was persisted to fall back on.
    expect(screen.getByRole('button', { name: /排序/ })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('veggieradar_sort_v1')).toBeNull();
  });
});
