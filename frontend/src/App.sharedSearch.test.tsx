import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResponse, ProduceItem } from './types/produce';

/**
 * What a *shared live-search result* does to the recipient.
 *
 * The board carries roughly 93 of the ~104 defined crops on any given day; the
 * rest are found by asking the backend. A card obtained that way is on nobody's
 * board — not the sharer's, not the recipient's — so `#/i/<name>` alone cannot
 * reopen it, and `useBoardView` used to answer 「今日無交易資料」 for a price the
 * sender had been looking at seconds earlier (#64).
 *
 * These need the backend to answer, so unlike `App.test.tsx` — which runs
 * against the bundled board with no API base — `searchProduce` is stubbed here.
 */
const searchProduce = vi.hoisted(() => vi.fn<(query: string) => Promise<ApiResponse>>());

vi.mock('./services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./services/api')>()),
  searchProduce,
}));

const { default: App } = await import('./App');
const { parseUrlState } = await import('./lib/urlState');

/** A crop in the catalogue that today's board does not carry. */
const loquat: ProduceItem = {
  code: 'X99',
  name: '枇杷',
  official_name: '枇杷',
  category: '水果',
  avg_price: 62.5,
  catty_price: 37.5,
  change_percent: -4.2,
  trade_volume: 8200,
  unit: '公斤',
  markets_count: 4,
};

const found = (): ApiResponse => ({
  type: 'search',
  query: '枇杷',
  date: '2026-08-26',
  count: 1,
  items: [loquat],
});

const notFound = (): ApiResponse => ({
  type: 'search',
  query: '枇杷',
  date: '2026-08-26',
  count: 0,
  items: [],
});

/** Land the window on a hash the way a pasted link would. */
const at = (hash: string) => window.history.replaceState(null, '', `/VeggieRadar/${hash}`);

beforeEach(() => {
  at('');
  localStorage.clear();
  searchProduce.mockReset();
});

describe('App — a shared live-search result', () => {
  it('opens the drawer for a crop the board does not carry', async () => {
    searchProduce.mockResolvedValue(found());
    at('#/i/枇杷?q=枇杷');
    render(<App />);

    const drawer = await screen.findByTestId('detail-drawer');
    expect(within(drawer).getByText('枇杷')).toBeInTheDocument();
    expect(searchProduce).toHaveBeenCalledWith('枇杷');
  });

  it('leaves the link alone while the backend is still answering', async () => {
    // The regression: `missing` fired the moment the board landed, because the
    // named crop is in nobody's board by definition. The URL was rewritten and
    // the drawer dismissed before the answer that justifies them arrived.
    searchProduce.mockResolvedValue(found());
    at('#/i/枇杷?q=枇杷');
    render(<App />);

    await screen.findByTestId('detail-drawer');
    expect(parseUrlState(window.location.hash).item).toBe('枇杷');
    expect(screen.queryByText(/今日無交易資料/)).not.toBeInTheDocument();
  });

  it('still says so when the backend genuinely has nothing', async () => {
    searchProduce.mockResolvedValue(notFound());
    at('#/i/枇杷?q=枇杷');
    render(<App />);
    await screen.findByText('高麗菜');

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('「枇杷」今日無交易資料'));
    expect(screen.queryByTestId('detail-drawer')).not.toBeInTheDocument();
    // The query survives the rewrite — only the item is dropped.
    await waitFor(() => expect(parseUrlState(window.location.hash).item).toBeNull());
    expect(parseUrlState(window.location.hash).query).toBe('枇杷');
  });

  it('carries the query in the share link for a crop found by search', async () => {
    searchProduce.mockResolvedValue(found());
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    at('#/i/枇杷?q=枇杷');
    render(<App />);

    const drawer = await screen.findByTestId('detail-drawer');
    within(drawer).getByRole('button', { name: /分享/ }).click();

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const shared = parseUrlState(new URL(writeText.mock.calls[0][0]).hash);
    expect(shared.item).toBe('枇杷');
    expect(shared.query).toBe('枇杷');
  });

  it('leaves a board item’s share link as the bare item', async () => {
    // The sharer's search is how *he* was reading the board, and the recipient
    // already has this card. Only a crop off the board needs the query.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    at('#/i/高麗菜');
    render(<App />);

    const drawer = await screen.findByTestId('detail-drawer');
    within(drawer).getByRole('button', { name: /分享/ }).click();

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const shared = parseUrlState(new URL(writeText.mock.calls[0][0]).hash);
    expect(shared.item).toBe('高麗菜');
    expect(shared.query).toBe('');
  });
});
