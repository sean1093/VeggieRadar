/**
 * Product analytics — a thin, typed wrapper over the GA4 `gtag` that
 * index.html loads.
 *
 * Why this exists: the roadmap defers features ("今日推薦" waits for the
 * 划算優先 sort to prove demand) and the README describes several degraded
 * modes (the localStorage fallback, `transient` search errors, trend
 * timeouts) — and none of it was measured. Page views cannot answer "how often
 * does the fallback carry a visit" or "does anyone use the sort". These events
 * can. Each one maps to a decision; see the README's Analytics section.
 *
 * Rules:
 *   - Never PII. No search text (only its outcome and length), no watched
 *     item names (only a count bucket). Produce names are not personal, but
 *     a search box accepts anything.
 *   - Low cardinality. Ages and counts are bucketed so GA4 can aggregate them.
 *   - Never in the way. `gtag` is absent in tests, offline, and under ad
 *     blockers; every call is a silent no-op then, and a throwing `gtag` is
 *     swallowed. Analytics must not be able to break the board.
 */

export type EventName =
  | 'board_loaded'
  | 'board_fallback'
  | 'search_result'
  | 'sort_changed'
  | 'filter_changed'
  | 'watch_toggled'
  | 'drawer_opened'
  | 'share'
  | 'trend_result'
  | 'chunk_failed'
  | 'board_schema_mismatch';

export type EventParams = Record<string, string | number | boolean>;

type Gtag = (command: 'event', name: string, params?: EventParams) => void;

export function track(name: EventName, params: EventParams = {}): void {
  try {
    const gtag = (globalThis as { gtag?: unknown }).gtag;
    if (typeof gtag !== 'function') return;
    (gtag as Gtag)('event', name, params);
  } catch {
    // Analytics never gets to break the UI.
  }
}

/** Board age as a coarse bucket, from an ISO `generated_at` (or unknown). */
export function ageBucket(generatedAt: string | undefined, now: number = Date.now()): string {
  if (!generatedAt) return 'unknown';
  const built = Date.parse(generatedAt);
  if (Number.isNaN(built)) return 'unknown';
  const hours = (now - built) / 3_600_000;
  if (hours < 1) return '<1h';
  if (hours < 6) return '1-6h';
  if (hours < 24) return '6-24h';
  return '>24h';
}

/** Small-integer counts as buckets, so a watchlist size never becomes an identifier. */
export function countBucket(n: number): string {
  if (n <= 0) return '0';
  if (n <= 3) return '1-3';
  if (n <= 10) return '4-10';
  return '>10';
}
