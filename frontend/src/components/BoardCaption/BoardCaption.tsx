import React from 'react';
import { useOnline } from '../../hooks/useOnline';
import type { FreshnessNotice } from '../../lib/utils/freshness';

interface BoardCaptionProps {
  /** 今日菜價, or 搜尋「…」 while a query is on screen. */
  title: string;
  /** Trading date of the prices below; empty while there is no board yet. */
  date: string;
  freshness: FreshnessNotice;
  /** Why the board below is the cached one, or null when it is current. */
  degradedReason: string | null;
  onRetry: () => void;
  /** A live query is in flight; the board below stays on screen meanwhile. */
  searching: boolean;
}

/**
 * The block above the board: what is being shown, how current it is, and how
 * to read the numbers. Every honesty caption the README asks for lives here —
 * the trading date next to the last refresh, the closure/staleness note, the
 * connection fallback with its retry, and that the big number is an estimate.
 */
const BoardCaption: React.FC<BoardCaptionProps> = ({
  title,
  date,
  freshness,
  degradedReason,
  onRetry,
  searching,
}) => {
  // A retry while the device says it is offline is certain to fail, so the
  // button says so instead of pretending. It stays tappable: `onLine` reports
  // the interface, not the internet, and the user may know better than it.
  const online = useOnline();

  return (
    <section className="pt-6 pb-5">
      <h2 className="text-2xl font-semibold tracking-tight text-ink">{title}</h2>
      {date && (
        <p className="mt-1 text-sm text-stone">
          資料日期 {date}・批發市場收盤均價
          {freshness.checkedAt && <span className="text-stone">・更新於 {freshness.checkedAt}</span>}
        </p>
      )}
      {freshness.note && <p className="mt-1 text-xs text-clay">{freshness.note}</p>}
      {degradedReason && (
        <p className="mt-1 text-xs text-clay">
          {degradedReason}
          <button onClick={onRetry} className="ml-2 underline underline-offset-2">
            {online ? '重試' : '離線中'}
          </button>
        </p>
      )}
      <p className="mt-1 text-xs text-stone">
        價格以每台斤（600&nbsp;克）計。<span className="text-sage">↓ 便宜</span>・<span className="text-clay">↑ 變貴</span>
      </p>
      <p className="mt-1 text-xs text-stone">
        大字為傳統市場零售推估（批發價加攤販常見加成），非實際報價；漲跌以批發價計。
      </p>
      {searching && <p className="mt-2 text-xs text-stone">查詢中…</p>}
    </section>
  );
};

export default BoardCaption;
