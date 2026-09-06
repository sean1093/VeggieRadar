import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchBoard, readCachedBoard } from '../services/api';
import { describeFreshness, type FreshnessNotice } from '../lib/utils/freshness';
import { isApiError, type ApiResponse, type BoardResponse, type ProduceItem } from '../types/produce';
import { ageBucket, track } from '../lib/analytics';

/**
 * The board lifecycle as one value.
 *
 * The four states are mutually exclusive by construction, so the combinations
 * the UI must never render — an error screen carrying a freshness note, a
 * "showing the last board" retry with no board behind it — cannot be built at
 * all. Before this they were merely avoided by the order of render conditions.
 */
export type BoardStatus =
  /** Nothing cached and nothing fetched yet: the first-paint skeleton. */
  | { kind: 'loading' }
  /**
   * Prices on screen. `cache` is the localStorage copy painted while the
   * revalidation is still in flight — it is the last board that loaded
   * successfully, so it carries no note; `gas` is the backend's answer.
   */
  | { kind: 'ready'; board: BoardResponse; source: 'gas' | 'cache' }
  /**
   * The fetch failed and the cached board is what a shopper is looking at.
   * Old prices plus `reason` and a retry beat a blank page in front of a stall.
   */
  | { kind: 'degraded'; board: BoardResponse; source: 'cache'; reason: string }
  /** The fetch failed with nothing to fall back on. */
  | { kind: 'error'; message: string };

export interface Board {
  status: BoardStatus;
  freshness: FreshnessNotice;
  reload: () => void;
}

// Says what a shopper needs to know: these are the last prices we got, not
// necessarily today's.
const UNREACHABLE = '目前連不上伺服器，顯示上次成功載入的行情';

const NO_NOTICE: FreshnessNotice = { note: null, checkedAt: null };
// One shared empty board keeps the identity stable, so the memos downstream of
// it do not recompute on every render of a boardless screen.
const NO_ITEMS: ProduceItem[] = [];

/** Items on screen for a status — empty whenever there is no board to show. */
export function boardItems(status: BoardStatus): ProduceItem[] {
  return status.kind === 'ready' || status.kind === 'degraded' ? status.board.items : NO_ITEMS;
}

/**
 * Owns the daily board: the cache-first paint, the background revalidation,
 * and the two ways a failure can land (degraded on the old board, or an error).
 */
export function useBoard(): Board {
  // The last good board, read once. It paints before the network answers, so
  // a slow or over-quota backend never holds the UI on a skeleton, and it
  // decides whether a failed fetch degrades (old prices, a note) or errors.
  const [initialCache] = useState(readCachedBoard);
  const [status, setStatus] = useState<BoardStatus>(() =>
    initialCache ? { kind: 'ready', board: initialCache, source: 'cache' } : { kind: 'loading' },
  );

  // Lands the backend's answer on top of whatever is on screen. The cache the
  // paint came from decides how a failure degrades: old prices plus a note
  // beat a blank page.
  const settle = useCallback((res: ApiResponse, cache: BoardResponse | null) => {
    if (isApiError(res)) {
      // How often the fallback carries a visit is the number behind the
      // static-mirror decision; `served` says whether there was anything
      // to fall back on.
      track('board_fallback', { served: cache ? 'cache' : 'none' });
      setStatus(
        cache
          ? { kind: 'degraded', board: cache, source: 'cache', reason: UNREACHABLE }
          : { kind: 'error', message: res.error },
      );
    } else if (res.type === 'board') {
      // `source` becomes a GA4 dimension with the static mirror (#13), when
      // there is a second value for it to take; a constant one is dead weight.
      track('board_loaded', { stale: !!res.stale, age_bucket: ageBucket(res.generated_at) });
      setStatus({ kind: 'ready', board: res, source: 'gas' });
    }
  }, []);

  // Mount: the cached board is already in the initial state, so the effect
  // only revalidates — nothing is set synchronously inside it. Both
  // dependencies are stable, so this runs once.
  useEffect(() => {
    fetchBoard().then((res) => settle(res, initialCache));
  }, [settle, initialCache]);

  // Retry, from the error screen or the connection note. Re-reads the cache
  // because a successful fetch since mount has refreshed it.
  const reload = useCallback(() => {
    const cached = readCachedBoard();
    setStatus(cached ? { kind: 'ready', board: cached, source: 'cache' } : { kind: 'loading' });
    fetchBoard().then((res) => settle(res, cached));
  }, [settle]);

  const freshness = useMemo<FreshnessNotice>(() => {
    if (status.kind !== 'ready' && status.kind !== 'degraded') return NO_NOTICE;
    const { date, generated_at: generatedAt, stale } = status.board;
    return describeFreshness({ date, generatedAt, stale });
  }, [status]);

  return { status, freshness, reload };
}
