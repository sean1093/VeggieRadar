import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchProduce } from '../services/api';
import { isApiError, type ProduceItem } from '../types/produce';
import { track } from '../lib/analytics';
import { searchTerms } from '../lib/normalizeQuery';

/**
 * Where a query stands.
 *
 * `searching` is a state of the *search box*, not of the board: a live query
 * in flight no longer blanks the prices already on screen, and `not_found`
 * only exists once the backend has actually answered — 查無此品項 must never
 * be shown while we still do not know.
 */
export type SearchStatus =
  | { kind: 'idle' }
  /** The board itself matched, instantly and without a request. */
  | { kind: 'local'; items: ProduceItem[] }
  /** A live backend query is in flight; the board stays visible under it. */
  | { kind: 'searching' }
  | { kind: 'remote'; items: ProduceItem[] }
  /**
   * The backend answered "no such produce". `suggestion` is the line it
   * offers instead — catalogue roots one edit from the query, or the board's
   * biggest sellers. Absent when the answer came from an older deploy.
   */
  | { kind: 'not_found'; suggestion?: string }
  /** Transport-level failure (busy backend, timeout) — a retry is worth offering. */
  | { kind: 'transient'; message: string };

export interface Search {
  query: string;
  status: SearchStatus;
  /** Enter: the board first, then the backend if the board has no answer. */
  search: (query: string) => void;
  /** Typing: a debounced local filter, which never costs a request. */
  preview: (query: string) => void;
  clear: () => void;
}

/**
 * How long the box may keep typing before the board narrows under it. Long
 * enough that a whole word is one filter pass, short enough to read as live.
 */
const PREVIEW_DEBOUNCE_MS = 300;

/**
 * Settled search states. A local hit is deliberately item-less here: its rows
 * are derived from the live board on every render, so a revalidation that
 * arrives while a query is on screen updates the prices under it instead of
 * leaving a frozen copy.
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'local' }
  | { kind: 'searching' }
  | { kind: 'remote'; items: ProduceItem[] }
  | { kind: 'not_found'; suggestion?: string }
  | { kind: 'transient'; message: string };

const IDLE: Phase = { kind: 'idle' };
const NO_ITEMS: ProduceItem[] = [];

/**
 * The instant path's match rule. `searchTerms` folds the query and adds the
 * MOA root the alias table maps it to, so 「onion」, 「高丽菜」 and 「大白菜」
 * match the board that is already on screen — each of them used to miss here
 * and cost a live backend query for an item the shopper could see.
 */
function matcher(query: string): (item: ProduceItem) => boolean {
  const terms = searchTerms(query);
  return (item) =>
    terms.some((term) => item.name.toLowerCase().includes(term) || item.official_name.includes(term));
}

/**
 * Items the board area should render for a search state. `idle` and
 * `searching` keep the board on screen: prices already fetched stay true while
 * a query is in flight, and blanking them for 15 s was the worst thing search
 * did to a shopper.
 */
export function itemsFor(status: SearchStatus, board: ProduceItem[]): ProduceItem[] {
  switch (status.kind) {
    case 'idle':
    case 'searching':
      return board;
    case 'local':
    case 'remote':
      return status.items;
    default:
      // not_found / transient — the answer is "nothing", and the empty state
      // or the busy notice explains which.
      return NO_ITEMS;
  }
}

/** Owns the query and its outcome; the board is what it matches against. */
export function useSearch(board: ProduceItem[]): Search {
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<Phase>(IDLE);
  // One ticket per search. A slower earlier query must not overwrite a newer
  // one, and `clear()` voids whatever is still in flight.
  const ticket = useRef(0);
  // The pending debounced preview. Anything that settles the box — Enter, the
  // clear button, unmount — must drop it, or a keystroke from before the
  // submit lands afterwards and resets the answer to idle.
  const previewTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => clearTimeout(previewTimer.current), []);

  const local = useMemo(() => (query ? board.filter(matcher(query)) : NO_ITEMS), [board, query]);

  const search = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      clearTimeout(previewTimer.current);
      const mine = ++ticket.current;
      setQuery(q);
      if (!q) {
        setPhase(IDLE);
        return;
      }
      // Outcome and length only — never the text; a search box accepts anything.
      const report = (outcome: 'local_hit' | 'remote_hit' | 'not_found' | 'transient') =>
        track('search_result', { outcome, query_length: q.length });

      // The board answers most queries with no request at all; only a miss
      // costs a live backend query.
      if (board.some(matcher(q))) {
        setPhase({ kind: 'local' });
        report('local_hit');
        return;
      }

      setPhase({ kind: 'searching' });
      const res = await searchProduce(q);
      if (mine !== ticket.current) return; // a newer search (or a clear) owns the box now

      if (isApiError(res)) {
        // A busy backend is never presented as 查無此品項: that would lie about
        // the produce rather than about us. A definitive miss carries the
        // backend's own suggestion — it knows the catalogue, this hook does not.
        setPhase(res.transient
          ? { kind: 'transient', message: res.error }
          : { kind: 'not_found', suggestion: res.suggestion });
        report(res.transient ? 'transient' : 'not_found');
      } else if (res.items.length) {
        setPhase({ kind: 'remote', items: res.items });
        report('remote_hit');
      } else {
        setPhase({ kind: 'not_found' });
        report('not_found');
      }
    },
    [board],
  );

  /**
   * What the box does while a word is still being typed: narrow the board
   * locally, never send anything. A miss here is deliberately *not*
   * 查無此品項 — mid-word we do not know, so the full board simply stays on
   * screen and Enter is what asks the backend. No analytics either: an event
   * per keystroke would drown the outcome rates in §6.
   */
  const preview = useCallback((raw: string) => {
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      ticket.current++; // whatever is in flight answers a query the box no longer holds
      setQuery(raw.trim());
      setPhase(IDLE);
    }, PREVIEW_DEBOUNCE_MS);
  }, []);

  const clear = useCallback(() => {
    clearTimeout(previewTimer.current);
    ticket.current++;
    setQuery('');
    setPhase(IDLE);
  }, []);

  // The live board always wins. The input is never disabled, so a query can
  // be submitted while the board is still loading: it misses an EMPTY board,
  // enters `searching`, and the revalidation may then deliver the very item
  // asked for. Whatever the backend answers afterwards — a hit, a miss or
  // 服務忙碌中 — must not hide rows that are now on screen. (Analytics keep
  // the outcome the request actually had; the UI shows the truth.)
  const status = useMemo<SearchStatus>(
    () => (local.length || phase.kind === 'local' ? { kind: 'local', items: local } : phase),
    [phase, local],
  );

  return { query, status, search, preview, clear };
}
