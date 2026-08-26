import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'veggie:watchlist:v1';

/** Reads the persisted watchlist, tolerating missing/corrupt/blocked storage. */
function loadWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Watchlist of produce keyed by `official_name` (stable across varieties/markets).
 * Only ids are stored; prices are always rendered from the live board.
 */
export function useWatchlist() {
  const [ids, setIds] = useState<string[]>(loadWatchlist);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch {
      // Private mode / quota exceeded — keep working in-memory only.
    }
  }, [ids]);

  const toggle = useCallback((id: string) => {
    setIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }, []);

  const isWatched = useCallback((id: string) => ids.includes(id), [ids]);

  return { ids, count: ids.length, isWatched, toggle };
}
