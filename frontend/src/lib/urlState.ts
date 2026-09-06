import { useSyncExternalStore } from 'react';

/**
 * The app's navigable state, expressed as a hash route:
 *
 *   #/                      the board
 *   #/i/高麗菜               that item's drawer (display `name`, percent-encoded)
 *   #/?q=蔥                  a search
 *   #/?f=葉菜類&sort=value    a filter and an order
 *
 * Hash rather than path because GitHub Pages has no server to rewrite deep
 * paths, and hand-rolled rather than a router because there is one route with
 * four parameters — a router would weigh more than the feature it serves.
 *
 * Why any of it is in the URL: the growth channel for this app is one shopper
 * pasting today's price into a LINE group, and that needs a link to a *state*,
 * not to the home screen. Making the drawer a history entry then hands the
 * Android back key its expected job — close the drawer, don't leave the app.
 */

/** Board order. The URL is where this vocabulary is validated. */
export type SortMode = 'category' | 'value';

export interface UrlState {
  /** Display name of the item whose drawer is open; null on the board. */
  item: string | null;
  query: string;
  /** `all`, `watch`, or a category label. */
  filter: string;
  /**
   * Only what the URL says. `null` means it is silent about the order, so the
   * reader's own persisted choice stands: a shared link is about a price, and
   * has no business resetting how someone else reads the board.
   */
  sort: SortMode | null;
}

/** Every default in one place — what an empty hash means. */
const BOARD: UrlState = { item: null, query: '', filter: 'all', sort: null };

/**
 * `/i/<name>`, or null for anything else — including a bare `/`, an empty name
 * and a deeper path. Nothing here throws or reports: a link that arrives
 * mangled should land on the board, which is always a truthful answer.
 */
function itemName(path: string): string | null {
  if (!path.startsWith('/i/')) return null;
  try {
    return decodeURIComponent(path.slice(3)).trim() || null;
  } catch {
    // A clipped percent-escape — chat apps do truncate long links.
    return null;
  }
}

export function parseUrlState(hash: string): UrlState {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const cut = raw.indexOf('?');
  const params = new URLSearchParams(cut === -1 ? '' : raw.slice(cut + 1));
  const sort = params.get('sort');
  return {
    item: itemName(cut === -1 ? raw : raw.slice(0, cut)),
    query: params.get('q')?.trim() ?? BOARD.query,
    filter: params.get('f')?.trim() || BOARD.filter,
    sort: sort === 'category' || sort === 'value' ? sort : BOARD.sort,
  };
}

export function serializeUrlState(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.filter !== BOARD.filter) params.set('f', state.filter);
  if (state.sort) params.set('sort', state.sort);
  const query = params.toString();
  return `#${state.item ? `/i/${encodeURIComponent(state.item)}` : '/'}${query ? `?${query}` : ''}`;
}

/**
 * The absolute link the share button hands out. Deliberately just the item:
 * the sharer's filter, sort and search are how *he* was reading the board.
 */
export function itemUrl(name: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}${serializeUrlState({ ...BOARD, item: name })}`;
}

const listeners = new Set<() => void>();
// Cached per hash string: `useSyncExternalStore` compares snapshots by
// identity, so a freshly parsed object on every render would never settle.
let cached: { hash: string; state: UrlState } | null = null;

function snapshot(): UrlState {
  const hash = window.location.hash;
  if (cached?.hash !== hash) cached = { hash, state: parseUrlState(hash) };
  return cached.state;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener('popstate', onChange);
  };
}

/** The current URL state, re-read on back/forward and on the writes below. */
export function useUrlState(): UrlState {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * `pushState` and `replaceState` fire no event, so the store is notified by
 * hand — that is the whole reason writes go through here rather than through
 * `history` directly.
 */
function write(patch: Partial<UrlState>, mode: 'push' | 'replace'): void {
  const { location, history } = window;
  const hash = serializeUrlState({ ...snapshot(), ...patch });
  // Nothing moved. A duplicate entry would cost the reader an extra back press.
  if (hash === location.hash) return;
  // pathname and search are kept: the app is served from /VeggieRadar/, and a
  // campaign parameter belongs to the visit rather than to the view.
  const url = `${location.pathname}${location.search}${hash}`;
  if (mode === 'push') history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  for (const onChange of listeners) onChange();
}

/** Opening or closing the drawer is a navigation, so it earns a history entry. */
export function pushUrlState(patch: Partial<UrlState>): void {
  write(patch, 'push');
}

/**
 * Filter, sort and query rewrite the current entry. They are how the board is
 * being read, not where the reader is; an entry each would turn the back key
 * into an undo button for chip taps.
 */
export function replaceUrlState(patch: Partial<UrlState>): void {
  write(patch, 'replace');
}
