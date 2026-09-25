/**
 * The report is the only artefact of a run, so what it must never do is state a
 * number it did not measure. These tests build a split whose answers are known
 * and check what the markdown says about it.
 */
import { describe, it, expect } from 'vitest';
import { dailySplit, cropStats, marketSightings } from '../src/measure.ts';
import type { CropDef, MoaRow } from '../src/backend.ts';
import { renderReport } from '../src/report.ts';
import type { RunMeta } from '../src/report.ts';

const CABBAGE: CropDef = { name: '高麗菜', official: '甘藍', category: '葉菜類' };

const META: RunMeta = {
  from: '2026-09-01', to: '2026-09-03', minTradeVolume: 200,
  requests: 4, cacheHits: 0, retries: 0, failures: 0, truncated: [], itemsRequested: 1,
};

function row(date: string, market: string, price: number, qty: number): MoaRow {
  return { TransDate: date, CropName: '甘藍', MarketName: market, MarketCode: '000', Avg_Price: price, Trans_Quantity: qty };
}

function render(rows: MoaRow[]): string {
  const days = dailySplit(rows, CABBAGE);
  return renderReport(META, marketSightings(new Map([['甘藍', rows]])), [cropStats(CABBAGE, days)]);
}

const NORTH_AND_CENTRAL = [
  row('115.09.01', '台北一', 30, 1000), row('115.09.01', '台中市', 20, 1000),
  row('115.09.02', '台北一', 30, 1000), row('115.09.02', '台中市', 20, 1000),
];

describe('renderReport', () => {
  it('leads with the market table issue #23 asks to verify', () => {
    const md = render(NORTH_AND_CENTRAL);
    expect(md).toContain('## 1. 市場對照表');
    expect(md.indexOf('## 1. 市場對照表')).toBeLessThan(md.indexOf('## 2.'));
    expect(md).toContain('| 台北一 | 000 | 北 |');
    expect(md).toContain('✅ 所有市場都有對應區域');
  });

  it('refuses to look settled while a market is unmapped', () => {
    const md = render([...NORTH_AND_CENTRAL, row('115.09.01', '新竹市', 40, 3000)]);
    expect(md).toContain('1 個市場未對應到區域');
    expect(md).toContain('新竹市');
    expect(md).not.toContain('✅');
  });

  it('names the truncated days rather than counting them', () => {
    const md = renderReport({ ...META, truncated: ['甘藍 2026-09-02', '蕹菜 2026-09-02'] },
      marketSightings(new Map([['甘藍', NORTH_AND_CENTRAL]])),
      [cropStats(CABBAGE, dailySplit(NORTH_AND_CENTRAL, CABBAGE))]);
    // Five roots truncating on one date is a different problem from one root
    // truncating on five, and the header has to let a reader tell them apart.
    expect(md).toContain('甘藍 2026-09-02、蕹菜 2026-09-02');
  });

  it('keeps a high-volume item in the headline table even with no spread to show', () => {
    // An item the board leans on that never has two qualifying regions is the
    // most important row in that table, not one to filter out.
    const northOnly = [row('115.09.01', '台北一', 30, 1000), row('115.09.02', '台北一', 30, 1000)];
    const md = render(northOnly);
    expect(md).toContain('| 高麗菜 | 2 | 0 | — | — |');
  });

  it('prints a dash, not 0%, for a region nothing qualified in', () => {
    const md = render(NORTH_AND_CENTRAL);
    // 東 has no trade at all: a 0.0% change gap would read as "tracks the
    // nationwide move perfectly", which is the opposite of "no data".
    expect(md).toContain('| 東 | 0 | — | — | — | — |');
    expect(md).toContain('| 高麗菜 | 葉菜類 | 2 |');
  });

  it('reports the spread and the per-region deviation it measured', () => {
    // 北 18 vs 中 12 元/台斤 against a nationwide 15 → 40% apart, ±20% each.
    const md = render(NORTH_AND_CENTRAL);
    expect(md).toContain('| 高麗菜 | 2 | 2 | 40.0% | 40.0% |');
    expect(md).toContain('100.0% / +20.0%');
    expect(md).toContain('100.0% / -20.0%');
  });

  it('states the gate it used, so a reader can see the numbers are the board’s', () => {
    expect(render(NORTH_AND_CENTRAL)).toContain('| MIN_TRADE_VOLUME | 200 kg');
  });
});
