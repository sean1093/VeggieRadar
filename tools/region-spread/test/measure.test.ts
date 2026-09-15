/**
 * What a regional board would publish, and how the three diagnostics behave on
 * a series whose answers can be worked out by hand.
 */
import { describe, it, expect } from 'vitest';
import { loadBackend } from '../src/backend.ts';
import type { CropDef, MoaRow } from '../src/backend.ts';
import { dailySplit, cropStats, marketSightings, quantile } from '../src/measure.ts';

const CABBAGE: CropDef = { name: '高麗菜', official: '甘藍', category: '葉菜類' };

function row(date: string, market: string, price: number, qty: number, crop = '甘藍-初秋'): MoaRow {
  return { TransDate: date, CropName: crop, MarketName: market, MarketCode: '000', Avg_Price: price, Trans_Quantity: qty };
}

/** Region for a region name on one day of a split, or undefined. */
function at(days: ReturnType<typeof dailySplit>, date: string, region: string) {
  return days.find((d) => d.date === date)?.regions.find((r) => r.region === region);
}

describe('dailySplit', () => {
  const rows = [
    row('115.09.01', '台北一', 20, 1000),
    row('115.09.01', '台中市', 30, 1000),
    row('115.09.01', '高雄市', 10, 100),
  ];

  it('blends each region in the unit the app shows, from the backend’s own average', () => {
    const [day] = dailySplit(rows, CABBAGE);
    expect(at([day], '2026-09-01', '北')?.catty).toBeCloseTo(12, 6); // 20 × 0.6
    expect(at([day], '2026-09-01', '中')?.catty).toBeCloseTo(18, 6);
    // 51,000 kg·元 over 2,100 kg = 24.2857 元/公斤
    expect(day.nationalCatty).toBeCloseTo(24.2857142857 * 0.6, 6);
    expect(day.nationalMarkets).toBe(3);
  });

  it('marks a region below MIN_TRADE_VOLUME as unqualified but still counts it nationally', () => {
    const [day] = dailySplit(rows, CABBAGE);
    const south = at([day], '2026-09-01', '南');
    expect(south?.volume).toBe(100);
    expect(south?.qualified).toBe(false);
    expect(at([day], '2026-09-01', '北')?.qualified).toBe(true);
    // The 100 kg the south could not show is inside the nationwide blend.
    expect(day.nationalVolume).toBe(2100);
  });

  it('drops a day the board itself would not publish', () => {
    // 150 kg island-wide is below MIN_TRADE_VOLUME: there is no card that day,
    // so counting it would flatter every regional coverage number.
    expect(dailySplit([row('115.09.01', '台北一', 20, 150)], CABBAGE)).toEqual([]);
  });

  it('uses the backend’s row filter, so 休市 and other crops cannot enter a region', () => {
    const mixed = [
      row('115.09.01', '台北一', 20, 1000),
      { TransDate: '115.09.01', CropName: '休市', MarketName: '台中市', Avg_Price: 0, Trans_Quantity: 0 },
      row('115.09.01', '台中市', 99, 5000, '包心白菜'),
    ];
    const [day] = dailySplit(mixed, CABBAGE);
    expect(day.regions.map((r) => r.region)).toEqual(['北']);
    expect(day.nationalVolume).toBe(1000);
  });

  it('keeps the market names a region was built from, for the mix diagnostic', () => {
    const both = [row('115.09.01', ' 104 台北二 ', 20, 500), row('115.09.01', '台北一', 20, 500)];
    expect(at(dailySplit(both, CABBAGE), '2026-09-01', '北')?.markets).toEqual(['台北一', '台北二']);
  });
});

/**
 * Three days built so every statistic can be checked by hand. 台北二 rests on
 * day 2 — the fixed weekday closure the whole change-percent worry is about.
 *
 *          北 (台北一/台北二)   中 (台中市)   全台
 *   day 1  20 / 20             20            20
 *   day 2  30 / —              20            25
 *   day 3  30 / 30             20            26.667
 */
const SERIES = [
  row('115.09.01', '台北一', 20, 1000), row('115.09.01', '台北二', 20, 1000), row('115.09.01', '台中市', 20, 1000),
  row('115.09.02', '台北一', 30, 1000), row('115.09.02', '台中市', 20, 1000),
  row('115.09.03', '台北一', 30, 1000), row('115.09.03', '台北二', 30, 1000), row('115.09.03', '台中市', 20, 1000),
];

describe('cropStats', () => {
  const stats = cropStats(CABBAGE, dailySplit(SERIES, CABBAGE));
  const north = stats.regions.find((r) => r.region === '北')!;
  const central = stats.regions.find((r) => r.region === '中')!;
  const east = stats.regions.find((r) => r.region === '東')!;

  it('measures the spread a region switcher would actually show', () => {
    // (18 − 12) ÷ 15 = 40% on day 2, ÷ 16 = 37.5% on day 3, 0% on day 1.
    expect(stats.spreadDays).toBe(3);
    expect(stats.medianSpreadPct).toBeCloseTo(37.5, 6);
    expect(stats.p90SpreadPct).toBeCloseTo(39.5, 6);
  });

  it('reports each region’s level difference from the nationwide price', () => {
    expect(north.medianDeviationPct).toBeCloseTo(12.5, 6);
    expect(central.medianDeviationPct).toBeCloseTo(-20, 6);
  });

  it('counts coverage over the days the board published, and calls a region viable on it', () => {
    expect(stats.days).toBe(3);
    expect(north.coverage).toBe(1);
    expect(north.viable).toBe(true);
    expect(east.qualifiedDays).toBe(0);
    expect(east.viable).toBe(false);
    expect(stats.viableRegions).toBe(2);
  });

  it('separates a regional move from the nationwide one over the same date pair', () => {
    // day 1→2: north +50%, nationwide +25% → 25 points apart.
    // day 2→3: north 0%, nationwide +6.67% → 6.67 points apart.
    expect(north.changePairs).toBe(2);
    expect(north.medianChangeGapPct).toBeCloseTo((25 + 20 / 3) / 2, 6);
    expect(north.medianGapDays).toBe(1);
    // The central price never moved, so its regional change is the honest one.
    expect(central.medianChangeGapPct).toBeGreaterThan(0);
  });

  it('counts how often the contributing markets changed between consecutive days', () => {
    // 台北二 rests on day 2 and returns on day 3: both pairs churn.
    expect(north.mixChurn).toBe(1);
    expect(north.medianMarkets).toBe(2);
    // One market all three days, so nothing in 中's move comes from the mix.
    expect(central.mixChurn).toBe(0);
  });

  it('leaves an unmapped market out of the spread rather than treating 其他 as a region', () => {
    const withStranger = [...SERIES, row('115.09.01', '新竹市', 100, 5000)];
    const day = dailySplit(withStranger, CABBAGE)[0];
    expect(day.regions.some((r) => r.region === '其他')).toBe(true);
    // 其他 is the dearest bucket that day; if it counted, the spread would jump.
    const spread = cropStats(CABBAGE, [day]).medianSpreadPct;
    expect(spread).toBe(0);
  });
});

describe('marketSightings', () => {
  it('collects every market the feed really traded in, with its codes', () => {
    const seen = marketSightings(new Map([['甘藍', [
      { ...row('115.09.01', '台北二', 20, 1000), MarketCode: '104' },
      { ...row('115.09.02', ' 104 台北二 ', 20, 500), MarketCode: '104' },
      { TransDate: '115.09.01', CropName: '休市', MarketName: '花蓮市', Avg_Price: 0, Trans_Quantity: 0 },
    ]]]));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: '台北二', codes: ['104'], region: '北', days: 2, volume: 1500 });
  });

  it('surfaces a market the region table has never been confirmed to contain', () => {
    const seen = marketSightings(new Map([['甘藍', [row('115.09.01', '新竹市', 20, 1000)]]]));
    expect(seen[0].region).toBe('其他');
  });
});

describe('quantile', () => {
  it('is the backend’s own median at q = 0.5, so the report cannot drift from the board', () => {
    const backend = loadBackend();
    for (const sample of [[5], [1, 9], [3, 1, 2], [4, 1, 3, 2], [7, 7, 1, 2, 9]]) {
      expect(quantile(sample, 0.5)).toBe(backend.median(sample));
    }
  });

  it('returns 0 for an empty sample instead of NaN', () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([], 0.9)).toBe(0);
  });
});
