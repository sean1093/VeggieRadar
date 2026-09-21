import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('keeps the link alive when the backend is merely busy', async () => {
    // A transient failure is not an answer. Treating it as one strips the item
    // from the URL and says the crop has no trading data — the same lie, on
    // the one branch where the backend never claimed anything.
    searchProduce.mockResolvedValue({ error: '服務忙碌中，請稍後再試', query: '枇杷', transient: true });
    at('#/i/枇杷?q=枇杷');
    render(<App />);
    await screen.findByText(/服務忙碌中/);

    expect(screen.queryByText(/今日無交易資料/)).not.toBeInTheDocument();
    expect(parseUrlState(window.location.hash).item).toBe('枇杷');
  });

  it('drops the no-data notice once a retry produces the crop', async () => {
    // The notice must not outlive the data it denies: a retry that succeeds
    // puts the price on the board without opening a drawer, and a sentence
    // saying there is none, directly above it, is worse than no sentence.
    searchProduce.mockResolvedValue(notFound());
    at('#/i/枇杷?q=枇杷');
    render(<App />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('今日無交易資料'));

    searchProduce.mockResolvedValue(found());
    fireEvent.change(screen.getByPlaceholderText(/搜尋蔬果/), { target: { value: '枇杷' } });
    fireEvent.submit(screen.getByPlaceholderText(/搜尋蔬果/).closest('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByTestId('produce-list')).toHaveTextContent('枇杷'));
    expect(screen.queryByText(/今日無交易資料/)).not.toBeInTheDocument();
  });

  it('asks the backend when the board only near-matches the linked crop', async () => {
    // `matcher` is a substring match, so `?q=花椰` hits 白花椰菜 on the board
    // while 花椰 itself is not on it. Answering that locally would settle the
    // query and leave the linked card unreachable — which is the whole point
    // of the required name.
    searchProduce.mockResolvedValue({
      type: 'search',
      query: '花椰',
      date: '2026-08-26',
      count: 1,
      items: [{ ...loquat, code: 'X98', name: '花椰', official_name: '花椰', category: '辛香類' }],
    });
    at('#/i/花椰?q=花椰');
    render(<App />);

    const drawer = await screen.findByTestId('detail-drawer');
    expect(within(drawer).getByText('花椰')).toBeInTheDocument();
    expect(searchProduce).toHaveBeenCalledWith('花椰');
    // The board's own near-match is still what the list behind the drawer
    // shows; the link's card is what the drawer shows.
    expect(screen.getByTestId('produce-list')).toHaveTextContent('花椰');
  });

  it('hands the board back when the backend has nothing to add', async () => {
    // The required name suspends the board's precedence while the backend is
    // looking. If the answer is 查無此品項 it must hand it straight back:
    // 白花椰菜 plainly matches `?q=花椰`, and hiding it behind an empty
    // 查無此品項 screen would be worse than not opening a drawer.
    searchProduce.mockResolvedValue({ type: 'search', query: '花椰', date: '2026-08-26', count: 0, items: [] });
    at('#/i/花椰?q=花椰');
    render(<App />);

    await waitFor(() => expect(screen.getByTestId('produce-list')).toHaveTextContent('白花椰菜'));
    expect(screen.queryByText(/查無此品項/)).not.toBeInTheDocument();
  });

  it('keeps asking for the linked card when the busy backend is retried', async () => {
    // The retry used to drop the required name. With a crop the board cannot
    // near-match there is nothing to fall back to, so the failure showed as
    // the drawer never opening however many times the visitor retried.
    searchProduce.mockResolvedValueOnce({ error: '服務忙碌中，請稍後再試', query: '枇杷', transient: true });
    at('#/i/枇杷?q=枇杷');
    render(<App />);
    const retry = await screen.findByRole('button', { name: /重試|重新/ });

    searchProduce.mockResolvedValue(found());
    fireEvent.click(retry);

    const drawer = await screen.findByTestId('detail-drawer');
    expect(within(drawer).getByText('枇杷')).toBeInTheDocument();
    expect(searchProduce).toHaveBeenLastCalledWith('枇杷');
  });

  it('offers the retry when a busy backend hides behind a matching board', async () => {
    // `status` collapses a transient phase to a local hit whenever the board
    // substring-matches, so reading the verdict off it made the busy branch
    // dead: the item was stripped from the URL and the crop declared absent,
    // with neither the busy notice nor a retry anywhere on screen.
    searchProduce.mockResolvedValue({ error: '服務忙碌中，請稍後再試', query: '花椰', transient: true });
    at('#/i/花椰?q=花椰');
    render(<App />);
    await waitFor(() => expect(searchProduce).toHaveBeenCalled());

    expect(screen.queryByText(/今日無交易資料/)).not.toBeInTheDocument();
    expect(parseUrlState(window.location.hash).item).toBe('花椰');
  });

  it('keeps the board narrowed while the backend is looking', async () => {
    // Suspending the board's precedence during the wait swapped the two
    // matching rows for all 94 and then snapped back.
    let answer: (r: ApiResponse) => void = () => {};
    searchProduce.mockReturnValue(new Promise<ApiResponse>((settle) => { answer = settle; }));
    at('#/i/花椰?q=花椰');
    render(<App />);
    await waitFor(() => expect(searchProduce).toHaveBeenCalled());

    const list = screen.getByTestId('produce-list');
    expect(list).toHaveTextContent('白花椰菜');
    expect(list).not.toHaveTextContent('高麗菜');
    answer({ type: 'search', query: '花椰', date: '2026-08-26', count: 0, items: [] });
  });

  it('releases a link the visitor has moved on from', async () => {
    // An unresolved item with a query that no longer belongs to it is a dead
    // link the next reload or address-bar share would hand out again.
    searchProduce.mockResolvedValue({ error: '服務忙碌中，請稍後再試', query: '枇杷', transient: true });
    at('#/i/枇杷?q=枇杷');
    render(<App />);
    await screen.findByRole('button', { name: /重試|重新/ });

    fireEvent.change(screen.getByPlaceholderText(/搜尋蔬果/), { target: { value: '高麗菜' } });
    fireEvent.submit(screen.getByPlaceholderText(/搜尋蔬果/).closest('form') as HTMLFormElement);

    await waitFor(() => expect(parseUrlState(window.location.hash).item).toBeNull());
    expect(screen.queryByText(/今日無交易資料/)).not.toBeInTheDocument();
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
