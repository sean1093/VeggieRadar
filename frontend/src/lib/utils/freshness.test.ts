import { describe, it, expect } from 'vitest';
import { BOARD_MAX_AGE_CEILING_MS, BOARD_MAX_AGE_MS, boardMaxAge, describeFreshness } from './freshness';

/** Local noon, so no time zone can push the comparison onto a different day. */
const at = (iso: string) => new Date(`${iso}T12:00:00`);

describe('describeFreshness', () => {
  it('stays quiet when the prices are from today', () => {
    const notice = describeFreshness(
      // 4-hourly refreshes, so a board read at noon was crawled hours ago at
      // the most — anything older is what the age rule below is for.
      { date: '2026-08-28', generatedAt: '2026-08-28T08:15:00+08:00' },
      at('2026-08-28'),
    );
    expect(notice.note).toBeNull();
    expect(notice.checkedAt).toBe('08/28 08:15');
  });

  it('explains that today has not closed yet when the prices are one day old', () => {
    const notice = describeFreshness({ date: '2026-08-27' }, at('2026-08-28'));
    expect(notice.note).toBe('今日行情尚未公布，顯示前一交易日收盤價');
  });

  it('blames market closure once the prices are two or more days old', () => {
    // The real 2026-08-28 case: MOA published only 休市 rows for 08-27 and 08-28.
    const notice = describeFreshness(
      { date: '2026-08-26', generatedAt: '2026-08-28T08:05:00+08:00' },
      at('2026-08-28'),
    );
    expect(notice.note).toBe('批發市場休市中，顯示最近一次收盤行情');
    expect(notice.checkedAt).toBe('08/28 08:05');
  });

  it('reports a broken refresh instead of blaming 休市 when the board is stale', () => {
    const notice = describeFreshness(
      { date: '2026-08-26', generatedAt: '2026-08-26T00:10:00+08:00', stale: true },
      at('2026-08-28'),
    );
    expect(notice.note).toBe('資料更新中，稍後重新整理可看到最新行情');
    expect(notice.checkedAt).toBe('08/26 00:10');
  });

  it('has no refresh time to show for a board that predates generated_at', () => {
    const notice = describeFreshness({ date: '2026-08-26', stale: true }, at('2026-08-28'));
    expect(notice.checkedAt).toBeNull();
    expect(notice.note).toBe('資料更新中，稍後重新整理可看到最新行情');
  });

  /**
   * The static mirror (README §2) is a file: the `stale: false` inside it froze
   * when the Pages deploy published it and keeps claiming freshness for as
   * long as the CDN serves it. Staleness is therefore computed from
   * `generatedAt`, and the payload's flag can only add to it.
   */
  it('calls a 20-hour-old board stale however fresh the payload claims to be', () => {
    const notice = describeFreshness(
      { date: '2026-08-28', generatedAt: '2026-08-27T16:00:00+08:00', stale: false },
      at('2026-08-28'),
    );
    expect(notice.note).toBe('資料更新中，稍後重新整理可看到最新行情');
    expect(notice.checkedAt).toBe('08/27 16:00');
  });

  it('judges a board by the limit it carries: a day old is current in push mode (#103)', () => {
    const board = { date: '2026-08-28', generatedAt: '2026-08-27T16:00:00+08:00' };
    expect(describeFreshness({ ...board, maxAgeMs: 36 * 3_600_000 }, at('2026-08-28')).note).toBeNull();
    expect(describeFreshness({ ...board, maxAgeMs: 6 * 3_600_000 }, at('2026-08-28')).note).toMatch(/資料更新中/);
    // A 40-hour-old board is past even push mode's limit.
    expect(describeFreshness({ date: '2026-08-27', generatedAt: '2026-08-26T20:00:00+08:00', maxAgeMs: 36 * 3_600_000 },
      at('2026-08-28')).note).toMatch(/資料更新中/);
  });

  it('leaves a board inside the max age to the trading-date notices', () => {
    // 5.5 h old: one missed refresh is not a broken pipeline, and blaming the
    // refresh here would hide the real reason the prices are yesterday's.
    const notice = describeFreshness(
      { date: '2026-08-27', generatedAt: '2026-08-28T06:30:00+08:00' },
      at('2026-08-28'),
    );
    expect(notice.note).toBe('今日行情尚未公布，顯示前一交易日收盤價');
  });

  it('ignores an unusable date or timestamp rather than rendering NaN', () => {
    expect(describeFreshness({ date: 'not-a-date' }, at('2026-08-28')).note).toBeNull();
    expect(describeFreshness({ generatedAt: 'nope' }, at('2026-08-28')).checkedAt).toBeNull();
    expect(describeFreshness({}, at('2026-08-28'))).toEqual({ note: null, checkedAt: null });
  });
});

describe('boardMaxAge', () => {
  it('takes the limit the backend published with the board', () => {
    expect(boardMaxAge(36 * 3_600_000)).toBe(36 * 3_600_000);
    expect(boardMaxAge(6 * 3_600_000)).toBe(6 * 3_600_000);
  });

  it('falls back to the scheduled limit without a usable one', () => {
    for (const bad of [undefined, null, 0, -1, NaN, Infinity, '36', {}]) expect(boardMaxAge(bad)).toBe(BOARD_MAX_AGE_MS);
  });

  it('lets no board vouch for itself past the ceiling', () => {
    expect(boardMaxAge(365 * 24 * 3_600_000)).toBe(BOARD_MAX_AGE_CEILING_MS);
  });
});
