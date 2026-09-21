import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
/**
 * Holds the board back while a test needs it cold. The bundled board resolves
 * on a microtask, so "the visitor was already typing when it landed" was
 * otherwise a race against the mock rather than a state a test could ask for.
 */
const gate = vi.hoisted(() => ({ held: null as Promise<void> | null }));

vi.mock('./services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/api')>();
  return {
    ...actual,
    searchProduce,
    fetchBoard: async () => {
      if (gate.held) await gate.held;
      return actual.fetchBoard();
    },
  };
});

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

/** Keep the board from landing until the returned function is called. */
function holdBoard(): () => void {
  let land = () => {};
  gate.held = new Promise<void>((settle) => {
    land = () => {
      gate.held = null;
      settle();
    };
  });
  return () => land();
}

beforeEach(() => {
  at('');
  localStorage.clear();
  gate.held = null;
  searchProduce.mockReset();
  // A default, so a call this test did not plan for cannot resolve to
  // `undefined` and blow up inside `isApiError` as an unhandled rejection that
  // gets attributed to whichever test happened to be running.
  searchProduce.mockResolvedValue(notFound());
});

/**
 * The search box, holding `word`, with anything already scheduled for it
 * flushed. Typing straight after the first paint races the adoption, which
 * re-imposes the link's word one commit later and takes the keystroke with it
 * — the test then fails on whatever that keystroke was for rather than on the
 * race. The `await` is what closes that window; the value is asserted so a box
 * that stops carrying the URL's word says so here rather than three
 * assertions later.
 *
 * It cannot *wait for* the adoption: the box is seeded from `url.query` at
 * first paint, so it already holds that word before anything is adopted. Each
 * caller waits for a signal of its own first — the answer to the link's own
 * query, which the adoption is what issues.
 */
async function settledBox(word: string): Promise<HTMLElement> {
  const box = await screen.findByPlaceholderText(/搜尋蔬果/);
  await waitFor(() => expect(box).toHaveValue(word));
  return box;
}

/**
 * Type a word into the search box and let React commit it.
 *
 * A controlled input whose pending render has not flushed is restored to its
 * committed value, so an edit followed straight away by a submit or a tap can
 * be dropped entirely — and the test then fails on whatever that keystroke was
 * for, naming anything but the lost keystroke.
 */
async function typeWord(box: HTMLElement, word: string): Promise<void> {
  await act(async () => {
    fireEvent.change(box, { target: { value: word } });
  });
}

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
    // The word is already in the box — the retry here is Enter on it, not a
    // re-typing, and typing the value an input already holds fires no change
    // event at all.
    const box = await settledBox('枇杷');
    fireEvent.submit(box.closest('form') as HTMLFormElement);

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
    // The delivered card joins the board's near-matches rather than replacing
    // them. Asserting on 白花椰菜 is the point: 花椰 alone would be satisfied
    // by the delivered row itself and could never fail.
    const list = screen.getByTestId('produce-list');
    expect(list).toHaveTextContent('白花椰菜');
    expect(list).toHaveTextContent('花椰');
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
    // What the visitor must get: the busy message and something to press.
    expect(await screen.findByText(/服務忙碌中/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重試|重新/ })).toBeInTheDocument();
    // Not a claim the crop has no data — the backend never said that — and the
    // link survives, so the retry has something to retry.
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

    const box = await settledBox('枇杷');
    await typeWord(box, '高麗菜');
    fireEvent.submit(box.closest('form') as HTMLFormElement);

    await waitFor(() => expect(parseUrlState(window.location.hash).item).toBeNull());
    expect(screen.queryByText(/今日無交易資料/)).not.toBeInTheDocument();
  });

  it('does not close a drawer the visitor opened while typing', async () => {
    // `applyQuery` drops a stranded item, but it also runs from the typing
    // preview, which settles 300 ms late — long enough for a card tapped in
    // between to have opened a drawer this would otherwise close.
    at('#/i/高麗菜');
    render(<App />);
    await screen.findByTestId('detail-drawer');

    await new Promise((settle) => setTimeout(settle, 500));
    expect(screen.getByTestId('detail-drawer')).toBeInTheDocument();
    expect(parseUrlState(window.location.hash).item).toBe('高麗菜');
  });

  it('keeps the whole link through adoption, query included', async () => {
    // Both effects run in one commit, so the mirror used to see the
    // pre-adoption query — empty on a first load — and publish it over the
    // link it was adopting, stripping `?q=` and, once the item went with it,
    // the drawer as well.
    searchProduce.mockResolvedValue(found());
    at('#/i/枇杷?q=枇杷');
    render(<App />);
    await screen.findByTestId('detail-drawer');

    const settled = parseUrlState(window.location.hash);
    expect(settled.item).toBe('枇杷');
    expect(settled.query).toBe('枇杷');
  });

  it('releases a board item when a new query replaces it', async () => {
    // ✕ or a new search over a live-search drawer strands its card: the item
    // is on screen but nothing will resolve it once the query moves on.
    searchProduce.mockResolvedValue(found());
    at('#/i/枇杷?q=枇杷');
    render(<App />);
    await screen.findByTestId('detail-drawer');

    const box = await settledBox('枇杷');
    await typeWord(box, '高麗菜');
    fireEvent.submit(box.closest('form') as HTMLFormElement);

    await waitFor(() => expect(parseUrlState(window.location.hash).item).toBeNull());
    expect(screen.queryByText(/今日無交易資料/)).not.toBeInTheDocument();
  });

  it('does not spend a backend request for a board item’s own link', async () => {
    // `#/i/高麗菜?q=蔥` is an ordinary URL. Requiring a name the board already
    // carries would skip the local short-circuit and pay for an answer the
    // board has offline — and take the list down if that request failed.
    at('#/i/高麗菜?q=蔥');
    render(<App />);
    await screen.findByTestId('detail-drawer');

    await new Promise((settle) => setTimeout(settle, 300));
    expect(searchProduce).not.toHaveBeenCalled();
  });

  it('lets a word typed over a cold board beat the link it landed on', async () => {
    // The board can land after the visitor has started typing. Running the
    // URL's query then leaves the box saying one thing and the caption and URL
    // another, for the rest of the session.
    searchProduce.mockResolvedValue(found());
    // Both halves are held rather than raced: the board lands when this test
    // says so, and the 300 ms debounce is advanced rather than waited out.
    const landBoard = holdBoard();
    at('#/?q=蔥');
    render(<App />);
    const box = await screen.findByPlaceholderText(/搜尋蔬果/);

    vi.useFakeTimers();
    try {
      fireEvent.change(box, { target: { value: '番茄' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    } finally {
      vi.useRealTimers();
    }
    await act(async () => {
      landBoard();
    });

    await waitFor(() => expect(parseUrlState(window.location.hash).query).toBe('番茄'));
    expect(box).toHaveValue('番茄');
    expect(screen.getByTestId('produce-list')).toHaveTextContent('番茄');
  });

  it('does not erase a character still inside the debounce when the board lands', async () => {
    // The other end of the same guard: mid-word the *settled* query is still
    // the previous one, so comparing it let a board landing inside the 300 ms
    // window count as "they typed the link's own query" and adopt over
    // characters already on screen.
    searchProduce.mockResolvedValue(notFound());
    const landBoard = holdBoard();
    at('#/i/枇杷?q=枇杷');
    render(<App />);
    const box = await settledBox('枇杷');

    vi.useFakeTimers();
    try {
      // Two settled edits ending on the link's word, then one more character
      // left unsettled — the board lands with the box reading 枇杷汁 and the
      // hook still holding 枇杷.
      await act(async () => {
        fireEvent.change(box, { target: { value: '枇' } });
        await vi.advanceTimersByTimeAsync(400);
      });
      await act(async () => {
        fireEvent.change(box, { target: { value: '枇杷' } });
        await vi.advanceTimersByTimeAsync(400);
      });
      await act(async () => {
        fireEvent.change(box, { target: { value: '枇杷汁' } });
      });
      expect(box).toHaveValue('枇杷汁');

      await act(async () => {
        landBoard();
      });
      expect(box).toHaveValue('枇杷汁');
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fetches the linked card when the box has settled on the link's own query", async () => {
    // The other side of the same guard. The box arrives holding `?q=`, so a
    // visitor who edits it and comes back to that word before the board lands
    // has touched the box and is asking for exactly what the link asks for.
    // Suppressing the adoption there dropped the card, and since a debounced
    // preview never costs a request, nothing else would fetch it: the drawer
    // closed on 「今日無交易資料」 without one call to the backend.
    searchProduce.mockResolvedValue(found());
    const landBoard = holdBoard();
    at('#/i/枇杷?q=枇杷');
    render(<App />);
    const box = await settledBox('枇杷');

    vi.useFakeTimers();
    try {
      // Two settled edits, ending back on the link's word — not a net-zero
      // edit (that one never reaches the hook) but two real queries.
      await act(async () => {
        fireEvent.change(box, { target: { value: '枇' } });
        await vi.advanceTimersByTimeAsync(400);
      });
      await act(async () => {
        fireEvent.change(box, { target: { value: '枇杷' } });
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(box).toHaveValue('枇杷');
    } finally {
      vi.useRealTimers();
    }
    expect(searchProduce).not.toHaveBeenCalled(); // typing never spends a request

    await act(async () => {
      landBoard();
    });

    expect(await screen.findByTestId('detail-drawer')).toBeInTheDocument();
    expect(searchProduce).toHaveBeenCalledWith('枇杷');
    expect(parseUrlState(window.location.hash).item).toBe('枇杷');
  });

  it('still follows the URL after the visitor has used the box', async () => {
    // The typed-word override is for one moment — a word in progress when a
    // cold board lands. Latching it for the session killed the back key and
    // every later link: the mirror just rewrote the URL back to the box.
    searchProduce.mockResolvedValue(found());
    render(<App />);
    await screen.findByText('高麗菜');

    const box = await settledBox('');
    await typeWord(box, '蔥');
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    await waitFor(() => expect(parseUrlState(window.location.hash).query).toBe('蔥'));

    at('#/?q=番茄');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    await waitFor(() => expect(screen.getByTestId('produce-list')).toHaveTextContent('番茄'));
    expect(parseUrlState(window.location.hash).query).toBe('番茄');
    // The box lands a commit after the list — App detects the navigation, then
    // the header adopts it — so this needs its own wait.
    await waitFor(() => expect(box).toHaveValue('番茄'));
  });

  it('keeps the box out of reach while a linked drawer is open', async () => {
    // Why the URL and the search can never argue while a drawer is showing:
    // the drawer is a modal dialog, so the header is hidden from the
    // accessibility tree and the page takes no pointer events. Typing over a
    // linked card — which would reset the search phase and drop the link — is
    // not a path a visitor has. If the drawer ever stops being modal, this is
    // the test that should fail first.
    searchProduce.mockResolvedValue(found());
    at('#/i/枇杷?q=枇杷');
    render(<App />);
    await screen.findByTestId('detail-drawer');

    const box = screen.getByPlaceholderText(/搜尋蔬果/);
    expect(box.closest('[aria-hidden="true"], [data-aria-hidden="true"]')).not.toBeNull();
    expect(document.body.style.pointerEvents).toBe('none');
  });

  it('treats 搜尋 on the link’s own word as another try at the link', async () => {
    // 搜尋 rather than 重試 after a busy backend used to take the board's
    // short-circuit, make no request, strip the item and print the very
    // sentence this work exists to remove.
    searchProduce.mockResolvedValueOnce({ error: '服務忙碌中，請稍後再試', query: '花椰', transient: true });
    at('#/i/花椰?q=花椰');
    render(<App />);
    await screen.findByText(/服務忙碌中/);

    searchProduce.mockResolvedValue({
      type: 'search',
      query: '花椰',
      date: '2026-08-26',
      count: 1,
      items: [{ ...loquat, code: 'X98', name: '花椰', official_name: '花椰', category: '辛香類' }],
    });
    const box = screen.getByPlaceholderText(/搜尋蔬果/);
    fireEvent.submit(box.closest('form') as HTMLFormElement);

    const drawer = await screen.findByTestId('detail-drawer');
    expect(within(drawer).getByText('花椰')).toBeInTheDocument();
    expect(screen.queryByText(/今日無交易資料/)).not.toBeInTheDocument();
  });

  it('spends no request when 搜尋 asks a new question', async () => {
    // A word the visitor typed is their question, not the link's: it takes the
    // board's short-circuit as any typed search does.
    searchProduce.mockResolvedValueOnce({ error: '服務忙碌中，請稍後再試', query: '花椰', transient: true });
    at('#/i/花椰?q=花椰');
    render(<App />);
    await screen.findByText(/服務忙碌中/);
    searchProduce.mockClear();

    const box = await settledBox('花椰');
    await typeWord(box, '高麗菜');
    fireEvent.submit(box.closest('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByTestId('produce-list')).toHaveTextContent('高麗菜'));
    expect(searchProduce).not.toHaveBeenCalled();
  });

  it('survives a character typed and deleted while the link is in flight', async () => {
    // A net-zero edit is not a new query. Voiding the ticket for it cancelled
    // the linked search with nothing to re-issue it, so the crop was declared
    // missing, the item stripped and the real answer discarded.
    let answer: (r: ApiResponse) => void = () => {};
    searchProduce.mockReturnValue(new Promise<ApiResponse>((settle) => { answer = settle; }));
    at('#/i/枇杷?q=枇杷');
    render(<App />);
    await waitFor(() => expect(searchProduce).toHaveBeenCalled());
    const box = await settledBox('枇杷');

    // Plain fake timers, deliberately: the two edits have to land inside one
    // 300 ms debounce window for this to be a net-zero edit at all, and with
    // `shouldAdvanceTime` that window was real time — under a loaded full
    // suite the first edit settled on its own and the answer was discarded.
    vi.useFakeTimers();
    try {
      // One edit per `act`, and the value checked after each. A controlled
      // input whose pending render has not flushed is restored to the
      // committed value, and React then sees no change in the second edit at
      // all — the same test, failing for a reason it never names.
      await act(async () => {
        fireEvent.change(box, { target: { value: '枇杷x' } });
      });
      expect(box).toHaveValue('枇杷x');
      await act(async () => {
        fireEvent.change(box, { target: { value: '枇杷' } });
      });
      expect(box).toHaveValue('枇杷');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    } finally {
      vi.useRealTimers();
    }

    await act(async () => {
      answer(found());
    });
    expect(await screen.findByTestId('detail-drawer')).toBeInTheDocument();
    expect(parseUrlState(window.location.hash).item).toBe('枇杷');
  });

  it('does not let a pending keystroke close a card just tapped', async () => {
    // `applyQuery` drops a card the board does not carry, and it runs from the
    // 300 ms preview. A word typed just before the tap would settle after it.
    searchProduce.mockResolvedValue(found());
    at('#/?q=枇杷');
    render(<App />);
    const row = await screen.findByText('枇杷');
    const box = await settledBox('枇杷');

    vi.useFakeTimers();
    try {
      await typeWord(box, '高');
      fireEvent.click(row);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(screen.getByTestId('detail-drawer')).toBeInTheDocument();
    expect(parseUrlState(window.location.hash).item).toBe('枇杷');
  });

  it('keeps the board when a busy backend cannot answer the link', async () => {
    // The rows match the query and are prices the visitor can read. Removing
    // them to explain a card they cannot is the wrong trade; the explanation
    // and its retry go above them instead.
    searchProduce.mockResolvedValue({ error: '服務忙碌中，請稍後再試', query: '花椰', transient: true });
    at('#/i/花椰?q=花椰');
    render(<App />);
    await waitFor(() => expect(searchProduce).toHaveBeenCalled());

    expect(screen.getByTestId('produce-list')).toHaveTextContent('白花椰菜');
    expect(await screen.findByText(/服務忙碌中/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重試' })).toBeInTheDocument();
  });

  it('shares the query that found the card, not whatever is in the box', async () => {
    // Tapping a card inside the 300 ms debounce leaves a newer word in the
    // box. Quoting that in the link sends the recipient a question whose
    // answer never contains this crop.
    searchProduce.mockResolvedValue(found());
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    at('#/?q=枇杷');
    render(<App />);
    const row = await screen.findByText('枇杷');
    const box = await settledBox('枇杷');

    vi.useFakeTimers();
    try {
      await typeWord(box, '高');
      fireEvent.click(row);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    } finally {
      vi.useRealTimers();
    }

    const drawer = screen.getByTestId('detail-drawer');
    within(drawer).getByRole('button', { name: /分享/ }).click();
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(parseUrlState(new URL(writeText.mock.calls[0][0]).hash).query).toBe('枇杷');
  });

  it('restores a query the box had abandoned', async () => {
    // `urlWord` only moved where an external navigation was detected, so
    // returning to a query the box had already left changed nothing and the
    // box kept the abandoned word under a caption that said otherwise.
    searchProduce.mockResolvedValue(found());
    at('#/?q=蔥');
    render(<App />);
    const box = await screen.findByPlaceholderText(/搜尋蔬果/);
    await waitFor(() => expect(box).toHaveValue('蔥'));

    vi.useFakeTimers();
    try {
      fireEvent.change(box, { target: { value: '番茄' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(parseUrlState(window.location.hash).query).toBe('番茄'));

    at('#/?q=蔥');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    await waitFor(() => expect(box).toHaveValue('蔥'));
  });

  it('never leaves a link whose query cannot find its own card', async () => {
    // Tapping a card inside the debounce used to publish the newer word beside
    // the card's item: `#/i/枇杷?q=高`, which on reload spends a request for
    // 高, strips the item and prints the sentence this work removes.
    searchProduce.mockResolvedValue(found());
    at('#/?q=枇杷');
    render(<App />);
    const row = await screen.findByText('枇杷');
    const box = await settledBox('枇杷');

    vi.useFakeTimers();
    try {
      await typeWord(box, '高');
      fireEvent.click(row);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    } finally {
      vi.useRealTimers();
    }

    const settled = parseUrlState(window.location.hash);
    expect(settled.item).toBe('枇杷');
    expect(settled.query).toBe('枇杷');
    // …and the box says what the board is showing, not the word it dropped.
    expect(screen.getByPlaceholderText(/搜尋蔬果/)).toHaveValue('枇杷');
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
