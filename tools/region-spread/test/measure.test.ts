/**
 * What a regional board would publish, and how the three diagnostics behave on
 * a series whose answers can be worked out by hand.
 */
import { describe, it, expect } from 'vitest';
import { loadBackend } from '../src/backend.ts';
import type { CropDef, MoaRow } from '../src/backend.ts';
import {
  dailySplit, cropStats, marketSightings, quantile, VIABLE_MIN_DAYS,
  shortlist, SHORTLIST_TOP_VOLUME, SHORTLIST_MIN_SPREAD,
} from '../src/measure.ts';
import { REGIONS } from '../src/regions.ts';

const CABBAGE: CropDef = { name: '高麗菜', official: '甘藍', category: '葉菜類' };

function row(date: string, market: string, price: number, qty: number, crop = '甘藍-初秋'): MoaRow {
  return { TransDate: date, CropName: crop, MarketName: market, MarketCode: '000', Avg_Price: price, Trans_Quantity: qty };
}

/** One board item as the CLI hands it to `marketSightings`. */
function measured(def: CropDef, rows: MoaRow[], truncated = new Set<string>()) {
  return [{ def, rows, days: dailySplit(rows, def, truncated) }];
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

  it('drops a day MOA truncated, because a missing market reads as a price gap', () => {
    // The day is in the rows and would otherwise pass every gate; what is
    // wrong with it is invisible downstream, so it has to go here.
    const rows = [
      row('115.09.01', '台北一', 20, 1000), row('115.09.01', '台中市', 30, 1000),
      row('115.09.02', '台北一', 20, 1000), row('115.09.02', '台中市', 30, 1000),
    ];
    expect(dailySplit(rows, CABBAGE)).toHaveLength(2);
    const kept = dailySplit(rows, CABBAGE, new Set(['2026-09-01']));
    expect(kept.map((d) => d.date)).toEqual(['2026-09-02']);
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

  it('counts coverage over the days the board published', () => {
    expect(stats.days).toBe(3);
    expect(north.coverage).toBe(1);
    expect(east.qualifiedDays).toBe(0);
  });

  it('will not call a region viable on three days, however clean they are', () => {
    // 3 qualifying days out of 3 is 100% coverage and proves nothing about
    // whether 北 could carry a tab. A ratio is not evidence on its own.
    expect(north.coverage).toBe(1);
    expect(north.viable).toBe(false);
    expect(stats.viableRegions).toBe(0);
  });

  it('does not punish a region for resting, which is what the first real run hit', () => {
    // The live finding: all five northern markets trade 23 of 30 days, resting
    // on the same weekday, so 北's whole-window coverage is capped at 76.7%.
    // Judged on that, the region holding 49.6% of the island's volume read as
    // the least viable of four — a measurement of the market calendar, not of
    // whether the trade is there.
    const rows = [];
    for (let day = 1; day <= 30; day += 1) {
      const date = `115.09.${`${day}`.padStart(2, '0')}`;
      rows.push(row(date, '台中市', 30, 1000)); // open every day
      if (day % 10 !== 0) rows.push(row(date, '台北一', 20, 1000)); // shut 3 of 30
    }
    const north = cropStats(CABBAGE, dailySplit(rows, CABBAGE)).regions.find((r) => r.region === '北')!;
    expect(north.openDays).toBe(27);
    expect(north.qualifiedDays).toBe(27);
    // Open every day it could be, so the supply side is perfect…
    expect(north.coverageWhenOpen).toBe(1);
    // …while the user still sees a fallback on the days the market is shut.
    expect(north.coverage).toBeCloseTo(27 / 30, 6);
    expect(north.viable).toBe(true);
  });

  it('will not call a tab viable when it is empty most of the window', () => {
    // The over-correction the first version of this fix had: 北 supplies the
    // crop on 12 of 30 days and clears the gate on all 12, so the supply-side
    // figure is a perfect 100% — while a user switching to it falls back to
    // the nationwide price on the other 18 days.
    const rows = [];
    for (let day = 1; day <= 30; day += 1) {
      const date = `115.09.${`${day}`.padStart(2, '0')}`;
      rows.push(row(date, '台中市', 30, 1000));
      if (day <= 12) rows.push(row(date, '台北一', 20, 1000));
    }
    const north = cropStats(CABBAGE, dailySplit(rows, CABBAGE)).regions.find((r) => r.region === '北')!;
    expect(north.coverageWhenOpen).toBe(1);
    expect(north.coverage).toBeCloseTo(0.4, 6);
    expect(north.viable).toBe(false);
  });

  it('still calls a region unviable when it is open and short of the gate', () => {
    // The other half: open every day, but the trade is genuinely thin. That is
    // a data problem, and the distinction is the whole point of the split.
    const rows = [];
    for (let day = 1; day <= 30; day += 1) {
      const date = `115.09.${`${day}`.padStart(2, '0')}`;
      rows.push(row(date, '台中市', 30, 1000));
      rows.push(row(date, '台北一', 20, day % 2 ? 100 : 1000)); // half the days below 200 kg
    }
    const north = cropStats(CABBAGE, dailySplit(rows, CABBAGE)).regions.find((r) => r.region === '北')!;
    expect(north.openDays).toBe(30);
    expect(north.coverageWhenOpen).toBeLessThan(0.8);
    expect(north.viable).toBe(false);
  });

  it('calls it viable once there are enough qualifying days behind the ratio', () => {
    const long = [];
    for (let day = 1; day <= VIABLE_MIN_DAYS; day += 1) {
      const date = `115.09.${`${day}`.padStart(2, '0')}`;
      long.push(row(date, '台北一', 30, 1000), row(date, '台中市', 20, 1000));
    }
    const over = cropStats(CABBAGE, dailySplit(long, CABBAGE));
    expect(over.days).toBe(VIABLE_MIN_DAYS);
    expect(over.regions.find((r) => r.region === '北')!.viable).toBe(true);
    expect(over.regions.find((r) => r.region === '東')!.viable).toBe(false);
    expect(over.viableRegions).toBe(2);
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
    const seen = marketSightings(measured(CABBAGE, [
      { ...row('115.09.01', '台北二', 20, 1000), MarketCode: '104' },
      { ...row('115.09.02', ' 104 台北二 ', 20, 500), MarketCode: '104' },
      { TransDate: '115.09.01', CropName: '休市', MarketName: '花蓮市', Avg_Price: 0, Trans_Quantity: 0 },
    ]));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: '台北二', codes: ['104'], region: '北', days: 2, volume: 1500 });
  });

  it('counts a transaction once when two roots’ responses overlap', () => {
    // MOA substring-matches CropName, so a request for 蘿蔔 also answers with
    // 胡蘿蔔's rows: the same transaction arrives under both roots. Summed raw
    // it would double that market's volume, and with it the 占全國 column and
    // the unmapped-volume share the whole report is gated on.
    const shared = { TransDate: '115.09.01', CropName: '胡蘿蔔', MarketName: '台北一',
                     MarketCode: '109', Avg_Price: 20, Trans_Quantity: 1000 };
    const RADISH: CropDef = { name: '白蘿蔔', official: '蘿蔔', category: '根莖類' };
    const CARROT: CropDef = { name: '紅蘿蔔', official: '胡蘿蔔', category: '根莖類' };
    const radishRows = [shared, { ...shared, CropName: '蘿蔔', Trans_Quantity: 500 }];
    const seen = marketSightings([
      { def: RADISH, rows: radishRows, days: dailySplit(radishRows, RADISH) },
      { def: CARROT, rows: [shared], days: dailySplit([shared], CARROT) },
    ]);
    expect(seen).toHaveLength(1);
    // 1000 for 胡蘿蔔 once, plus 500 for 蘿蔔 — not 2000 + 500.
    expect(seen[0].volume).toBe(1500);
  });

  it('counts only the rows the board’s own items accept, like the rest of the report', () => {
    // MOA substring-matches, so a 甘藍 request also answers with 甘藍芽's rows.
    // Counting them would make 占全國 — and the unmapped share the whole report
    // is gated on — a share of a population sections 2–5 never look at.
    const seen = marketSightings(measured(CABBAGE, [
      row('115.09.01', '台北一', 20, 1000),
      { TransDate: '115.09.01', CropName: '甘藍芽', MarketName: '新竹市', MarketCode: '999',
        Avg_Price: 90, Trans_Quantity: 9000 },
    ]));
    expect(seen.map((m) => m.name)).toEqual(['台北一']);
  });

  it('keeps a row that differs in price or quantity, however alike it looks', () => {
    // De-duplication may only remove the overlap, which is the same row field
    // for field. Anything else is a transaction, and dropping one would
    // understate a market exactly as double-counting overstates it.
    const base = { TransDate: '115.09.01', CropName: '甘藍', MarketName: '台北一',
                   MarketCode: '109', Avg_Price: 20, Trans_Quantity: 1000 };
    const seen = marketSightings(measured(CABBAGE, [
      base,
      { ...base, Trans_Quantity: 700 },
      { ...base, Avg_Price: 25 },
      base, // the overlap: identical, counted once
    ]));
    expect(seen[0].volume).toBe(1000 + 700 + 1000);
  });

  it('keeps the same crop in two markets, or on two days, as two transactions', () => {
    const base = { CropName: '甘藍', Avg_Price: 20, Trans_Quantity: 1000 };
    const seen = marketSightings(measured(CABBAGE, [
      { ...base, TransDate: '115.09.01', MarketName: '台北一', MarketCode: '109' },
      { ...base, TransDate: '115.09.01', MarketName: '台中市', MarketCode: '400' },
      { ...base, TransDate: '115.09.02', MarketName: '台北一', MarketCode: '109' },
    ]));
    expect(seen.map((m) => m.volume).sort()).toEqual([1000, 2000]);
  });

  it('parses a quantity the way the backend does, so one odd row cannot NaN the table', () => {
    // `tradedRows` gates on parseFloat, so a row it passed can still be a
    // string `Number` refuses — and one NaN in a plain sum renders every
    // 占全國 cell, and the unmapped-volume gate, as NaN%.
    const seen = marketSightings(measured(CABBAGE, [
      { TransDate: '115.09.01', CropName: '甘藍', MarketName: '台北一', MarketCode: '109',
        Avg_Price: 20, Trans_Quantity: '1200 ' as unknown as number },
    ]));
    expect(seen[0].volume).toBe(1200);
  });

  it('ignores a market that only ever traded on a day the report dropped', () => {
    // A market seen only on an MOA-truncated day reaches no median, spread,
    // coverage ratio or churn count — so letting its volume into 占全國 would
    // turn the mapping check red over rows the report never looks at.
    const rows = [
      row('115.09.01', '新竹市', 90, 9000),
      row('115.09.02', '台北一', 20, 1000),
    ];
    const seen = marketSightings(measured(CABBAGE, rows, new Set(['2026-09-01'])));
    expect(seen.map((m) => m.name)).toEqual(['台北一']);
  });

  it('ignores a day the nationwide gate dropped, for the same reason', () => {
    // 150 kg island-wide is below MIN_TRADE_VOLUME: the board publishes no
    // card, `dailySplit` drops the day, and so must the roster.
    const rows = [
      row('115.09.01', '新竹市', 90, 150),
      row('115.09.02', '台北一', 20, 1000),
    ];
    expect(marketSightings(measured(CABBAGE, rows)).map((m) => m.name)).toEqual(['台北一']);
  });

  it('counts a row once per transaction, not once per look-alike', () => {
    // Two rows that merely match field for field are two transactions, and
    // `weightedAverage` counts both. Collapsing them here would make 占全國 a
    // share of a smaller population than sections 2–5 measure.
    const twice = [row('115.09.01', '台北一', 20, 1000), row('115.09.01', '台北一', 20, 1000)];
    expect(marketSightings(measured(CABBAGE, twice))[0].volume).toBe(2000);
  });

  it('counts a shared row once when two board items read the same fetched array', () => {
    // 花椰菜 backs both 白花椰菜 and 青花菜, and each item filters the same array.
    const rows = [row('115.09.01', '台北一', 20, 1000)];
    const both = [
      { def: CABBAGE, rows, days: dailySplit(rows, CABBAGE) },
      { def: CABBAGE, rows, days: dailySplit(rows, CABBAGE) },
    ];
    expect(marketSightings(both)[0].volume).toBe(1000);
  });

  it('gives an unnamed market a name rather than letting its volume vanish', () => {
    // `dailySplit` counts a nameless row into the nationwide blend and into
    // 其他; if the roster dropped it, section 1 could print its green check
    // over a day most of whose volume is unplaceable.
    const rows = [
      { TransDate: '115.09.01', CropName: '甘藍', MarketName: '  ', Avg_Price: 20, Trans_Quantity: 9000 },
      row('115.09.01', '台北一', 20, 1000),
    ];
    const seen = marketSightings(measured(CABBAGE, rows));
    expect(seen.map((m) => m.region)).toContain('其他');
    expect(seen.find((m) => m.region === '其他')?.volume).toBe(9000);
  });

  it('surfaces a market the region table has never been confirmed to contain', () => {
    const seen = marketSightings(measured(CABBAGE, [row('115.09.01', '新竹市', 20, 1000)]));
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

/**
 * The rule that decides which items get a 「各區批發價」 row. Each threshold is
 * here because it excludes a different way that row would mislead, so each is
 * tested on its own.
 */
describe('shortlist', () => {
  /** A CropStats with just the fields the rule reads. */
  function crop(name: string, volume: number, spread: number, viableRegions: number) {
    return {
      name, official: name, category: '葉菜類', days: 30, volume,
      spreadDays: spread > 0 ? 30 : 0, medianSpreadPct: spread, p90SpreadPct: spread * 1.5,
      viableRegions,
      regions: REGIONS.map((region, i) => ({
        region, qualifiedDays: 30, openDays: 30, coverage: 1, coverageWhenOpen: 1,
        medianMarkets: 2, medianVolume: 1000, medianDeviationPct: 0, p90AbsDeviationPct: 0,
        changePairs: 29, medianGapDays: 1, medianChangeGapPct: 0, p90ChangeGapPct: 0,
        mixChurn: 0, viable: i < viableRegions,
      })),
    };
  }

  it('takes a high-volume item whose regions really differ', () => {
    const picked = shortlist([crop('柿子', 2906, 48.7, 2)]);
    expect(picked.map((p) => p.crop.name)).toEqual(['柿子']);
    expect(picked[0].regions).toEqual(['北', '中']);
  });

  it('drops an item whose spread only restates the nationwide price', () => {
    // 紅蘿蔔 at 12.5% was the run's clearest case: real, and not worth a row.
    expect(shortlist([crop('紅蘿蔔', 2655, 12.5, 2)])).toEqual([]);
    expect(shortlist([crop('邊界', 2655, SHORTLIST_MIN_SPREAD, 2)])).toHaveLength(1);
  });

  it('drops an item with only one viable region, which is not a comparison', () => {
    expect(shortlist([crop('葡萄', 1554, 38.5, 1)])).toEqual([]);
  });

  it('drops the tail, where a spread is a grade difference rather than a region', () => {
    // 玉米筍 reported a 113.9% median on under 500 tonnes. Ranking by VOLUME is
    // what keeps it out — ranking by spread would select it first.
    const board = [
      ...Array.from({ length: SHORTLIST_TOP_VOLUME }, (_, i) => crop(`大量${i}`, 10000 - i, 35, 2)),
      crop('玉米筍', 473, 113.9, 2),
    ];
    const names = shortlist(board).map((p) => p.crop.name);
    expect(names).toHaveLength(SHORTLIST_TOP_VOLUME);
    expect(names).not.toContain('玉米筍');
  });

  it('returns them in volume order, not spread order', () => {
    const picked = shortlist([crop('小量', 100, 90, 2), crop('大量', 9000, 31, 2)]);
    expect(picked.map((p) => p.crop.name)).toEqual(['大量', '小量']);
  });

  it('says nothing is worth a row when nothing qualifies', () => {
    expect(shortlist([crop('紅蘿蔔', 2655, 12.5, 2)])).toEqual([]);
    expect(shortlist([])).toEqual([]);
  });
});
