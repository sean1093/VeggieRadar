import { useCallback, useMemo, useRef, useState } from 'react';
import { searchProduce } from '../services/api';
import { isApiError, type ProduceItem } from '../types/produce';
import { track } from '../lib/analytics';

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
  | { kind: 'not_found' }
  /** Transport-level failure (busy backend, timeout) — a retry is worth offering. */
  | { kind: 'transient'; message: string };

export interface Search {
  query: string;
  status: SearchStatus;
  search: (query: string) => void;
  clear: () => void;
}

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
  | { kind: 'not_found' }
  | { kind: 'transient'; message: string };

const IDLE: Phase = { kind: 'idle' };
const NO_ITEMS: ProduceItem[] = [];

/**
 * The instant path's match rule: the display name case-insensitively (people
 * type English and lower case), the MOA official name as given.
 */
function matcher(query: string): (item: ProduceItem) => boolean {
  const lower = query.toLowerCase();
  return (item) => item.name.toLowerCase().includes(lower) || item.official_name.includes(query);
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

  const local = useMemo(() => (query ? board.filter(matcher(query)) : NO_ITEMS), [board, query]);

  const search = useCallback(
    async (raw: string) => {
      const q = raw.trim();
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
        // the produce rather than about us.
        setPhase(res.transient ? { kind: 'transient', message: res.error } : { kind: 'not_found' });
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

  const clear = useCallback(() => {
    ticket.current++;
    setQuery('');
    setPhase(IDLE);
  }, []);

  const status = useMemo<SearchStatus>(
    () => (phase.kind === 'local' ? { kind: 'local', items: local } : phase),
    [phase, local],
  );

  return { query, status, search, clear };
}
