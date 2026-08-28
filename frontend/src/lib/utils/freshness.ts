/**
 * Explains how current the board is.
 *
 * Two different dates are in play and conflating them is what makes the app
 * look broken:
 *
 *   - `date` — the trading date of the prices. It legitimately stands still
 *     over weekends, holidays and typhoon closures, when the MOA feed carries
 *     nothing but `休市` placeholder rows.
 *   - `generated_at` — when the backend last crawled. This one must keep
 *     moving; a frozen `generated_at` means the refresh pipeline is dead.
 *
 * Showing only the trading date leaves a shopper unable to tell "the markets
 * were shut" from "this app stopped updating two days ago".
 */

export interface BoardFreshness {
  /** Trading date of the prices (ISO `YYYY-MM-DD`). */
  date?: string;
  /** When the backend last crawled (ISO timestamp). */
  generatedAt?: string;
  /** Backend flag: the board is past its max age and a rebuild is queued. */
  stale?: boolean;
}

export interface FreshnessNotice {
  /** Why the trading date is not today, or null when it is. */
  note: string | null;
  /** Last backend refresh as `MM/DD HH:mm`, or null when unknown. */
  checkedAt: string | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

function formatCheckedAt(iso: string): string | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return `${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

export function describeFreshness(board: BoardFreshness, now: Date = new Date()): FreshnessNotice {
  const checkedAt = board.generatedAt ? formatCheckedAt(board.generatedAt) : null;

  // A stale board is still served (old prices beat no prices), but its age can
  // no longer be explained by market closures, so say so plainly rather than
  // blaming 休市 for a broken refresh.
  if (board.stale) {
    return { note: '資料更新中，稍後重新整理可看到最新行情', checkedAt };
  }
  if (!board.date) return { note: null, checkedAt };

  // Whole days from the trading date to today, both read as local calendar
  // dates so a browser time zone cannot shift the comparison by one day.
  const traded = Date.parse(`${board.date}T00:00:00`);
  if (Number.isNaN(traded)) return { note: null, checkedAt };
  const today = Date.parse(
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T00:00:00`,
  );
  const gap = Math.round((today - traded) / MS_PER_DAY);

  if (gap <= 0) return { note: null, checkedAt };
  if (gap === 1) return { note: '今日行情尚未公布，顯示前一交易日收盤價', checkedAt };
  return { note: '批發市場休市中，顯示最近一次收盤行情', checkedAt };
}
