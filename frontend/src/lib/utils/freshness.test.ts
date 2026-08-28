import { describe, it, expect } from 'vitest';
import { describeFreshness } from './freshness';

/** Local noon, so no time zone can push the comparison onto a different day. */
const at = (iso: string) => new Date(`${iso}T12:00:00`);

describe('describeFreshness', () => {
  it('stays quiet when the prices are from today', () => {
    const notice = describeFreshness(
      { date: '2026-08-28', generatedAt: '2026-08-28T00:15:00+08:00' },
      at('2026-08-28'),
    );
    expect(notice.note).toBeNull();
    expect(notice.checkedAt).toBe('08/28 00:15');
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

  it('ignores an unusable date or timestamp rather than rendering NaN', () => {
    expect(describeFreshness({ date: 'not-a-date' }, at('2026-08-28')).note).toBeNull();
    expect(describeFreshness({ generatedAt: 'nope' }, at('2026-08-28')).checkedAt).toBeNull();
    expect(describeFreshness({}, at('2026-08-28'))).toEqual({ note: null, checkedAt: null });
  });
});
