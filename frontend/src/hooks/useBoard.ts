import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchBoard, fetchStaticBoard, isFreshEnough, readCachedBoard, writeCachedBoard } from '../services/api';
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
   * Prices on screen, from one of the three sources the board can come from
   * (README §2). `cache` is the localStorage copy painted while the read is
   * still in flight — it is the last board that loaded successfully, so it
   * carries no note; `static` is the mirror published with the app, and it is
   * authoritative while it is fresh; `gas` is the backend's own answer.
   */
  | { kind: 'ready'; board: BoardResponse; source: 'static' | 'gas' | 'cache' }
  /**
   * The GAS read failed and an older board is what a shopper is looking at:
   * the stale mirror it was revalidating, or the localStorage copy. Old prices
   * plus `reason` and a retry beat a blank page in front of a stall.
   */
  | { kind: 'degraded'; board: BoardResponse; source: 'static' | 'cache'; reason: string }
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

/**
 * The board a failed GAS read degrades onto, and the name of that source. The
 * pair travels together because a `degraded` status without a board is exactly
 * what the union forbids, and `served` is the same word the analytics event
 * reports.
 */
type Fallback = { board: BoardResponse; source: 'static' | 'cache' } | null;

const NO_NOTICE: FreshnessNotice = { note: null, checkedAt: null };
// One shared empty board keeps the identity stable, so the memos downstream of
// it do not recompute on every render of a boardless screen.
const NO_ITEMS: ProduceItem[] = [];

/** Items on screen for a status — empty whenever there is no board to show. */
export function boardItems(status: BoardStatus): ProduceItem[] {
  return status.kind === 'ready' || status.kind === 'degraded' ? status.board.items : NO_ITEMS;
}

/**
 * Owns the daily board: the cache-first paint, the read order behind it
 * (README §2 — localStorage, then the static mirror, then GAS), and the two
 * ways a failure can land (degraded on the old board, or an error).
 */
export function useBoard(): Board {
  // The last good board, read once. It paints before the network answers, so
  // a slow or over-quota backend never holds the UI on a skeleton, and it
  // decides whether a failed fetch degrades (old prices, a note) or errors.
  const [initialCache] = useState(readCachedBoard);
  const [status, setStatus] = useState<BoardStatus>(() =>
    initialCache ? { kind: 'ready', board: initialCache, source: 'cache' } : { kind: 'loading' },
  );

  // Lands GAS's answer on top of whatever is on screen. `fallback` is the
  // older board the paint came from, and it decides how a failure degrades:
  // old prices plus a note beat a blank page.
  const settle = useCallback((res: ApiResponse, fallback: Fallback) => {
    if (isApiError(res)) {
      // How often the fallback carries a visit, and off which source — a
      // `static` fallback means the mirror went stale *and* GAS is down,
      // which is a different incident from a lone browser's cache saving one
      // visit.
      track('board_fallback', { served: fallback ? fallback.source : 'none' });
      setStatus(
        fallback
          ? { kind: 'degraded', board: fallback.board, source: fallback.source, reason: UNREACHABLE }
          : { kind: 'error', message: res.error },
      );
    } else if (res.type === 'board') {
      track('board_loaded', { source: 'gas', stale: !!res.stale, age_bucket: ageBucket(res.generated_at) });
      setStatus({ kind: 'ready', board: res, source: 'gas' });
    }
  }, []);

  // One ticket per read. A retry from the banner while the first read is
  // still in flight would otherwise race it: whichever answer came last would
  // land, and a slow initial GAS failure could overwrite the retry's fresh
  // board with the degraded state. Only the newest read may touch the status.
  const generation = useRef(0);

  // One read of the board, in order (README §2). `cached` is what is already
  // on screen, so a failure has something to degrade onto even when there is
  // no mirror. Every state change sits behind a promise on purpose: the mount
  // effect calls this, and nothing may be set synchronously inside an effect.
  const load = useCallback(
    (cached: BoardResponse | null) => {
      const mine = ++generation.current;
      fetchStaticBoard().then(async (mirror) => {
        if (mine !== generation.current) return;
        if (mirror && isFreshEnough(mirror)) {
          // Authoritative: the mirror is younger than the backend's own max
          // age, so GAS would spend an execution to answer with the same
          // prices. `stale` is false by construction here rather than copied
          // from the payload, whose flag froze when the file was published.
          writeCachedBoard(mirror);
          track('board_loaded', { source: 'static', stale: false, age_bucket: ageBucket(mirror.generated_at) });
          setStatus({ kind: 'ready', board: mirror, source: 'static' });
          return;
        }

        // A stale mirror still goes on screen at once — the same trade as the
        // cache paint — but the read continues to GAS, whose `readBoard`
        // queues the rebuild that unsticks a dead pipeline. That self-heal is
        // why the mirror may only ever be a layer in front of GAS, never a
        // replacement.
        if (mirror) setStatus({ kind: 'ready', board: mirror, source: 'static' });

        // The stale mirror outranks the cache as the fallback: it is what the
        // shopper is already reading, and swapping in different old prices on
        // a failed refresh would be a change with nothing behind it.
        const fallback: Fallback = mirror
          ? { board: mirror, source: 'static' }
          : cached
            ? { board: cached, source: 'cache' }
            : null;
        const res = await fetchBoard();
        if (mine !== generation.current) return;
        settle(res, fallback);
      });
    },
    [settle],
  );

  // Mount: the cached board is already in the initial state, so the effect
  // only reads — nothing is set synchronously inside it. Both dependencies
  // are stable, so this runs once.
  useEffect(() => {
    load(initialCache);
  }, [load, initialCache]);

  // Retry, from the error screen or the connection note. Re-reads the cache
  // because a successful read since mount has refreshed it.
  const reload = useCallback(() => {
    const cached = readCachedBoard();
    setStatus(cached ? { kind: 'ready', board: cached, source: 'cache' } : { kind: 'loading' });
    load(cached);
  }, [load]);

  const freshness = useMemo<FreshnessNotice>(() => {
    if (status.kind !== 'ready' && status.kind !== 'degraded') return NO_NOTICE;
    const { date, generated_at: generatedAt, stale } = status.board;
    return describeFreshness({ date, generatedAt, stale });
  }, [status]);

  return { status, freshness, reload };
}
