/**
 * The feeds' shapes and the two name dictionaries.
 *
 * Every assertion here runs on committed fixtures — a refit must never depend
 * on the network to know whether its mappings are still sane.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBackend, defForRoot } from '../src/backend.ts';
import { COLUMN_TO_ROOT, IGNORED_COLUMNS, meltTaichung } from '../src/sources/taichung.ts';
import type { TaichungRow } from '../src/sources/taichung.ts';
import {
  ITEM_TO_ROOT, IGNORED_ITEMS, DATASET_ID, MIN_RESOURCES,
  meltTaipeiMonth, parseResources, unmappedItems, FIXTURE_PATH,
} from '../src/sources/taipei.ts';
import type { MonthlyResource } from '../src/sources/taipei.ts';
import { coverWindows, dailyWholesale } from '../src/sources/moa.ts';
import type { MoaRow } from '../src/backend.ts';

const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));

describe('the backend loader', () => {
  it('exposes the live row helpers and constants, not copies of them', () => {
    const backend = loadBackend();
    expect(backend.BOARD_ITEMS.length).toBeGreaterThan(90);
    expect(backend.CATTY_PER_KG).toBe(0.6);
    expect(backend.rowRoot('甘藍-初秋')).toBe('甘藍');
    expect(backend.selectRows(
      [
        { TransDate: '115.09.01', CropName: '蘿蔔-白', Avg_Price: 10, Trans_Quantity: 100 },
        { TransDate: '115.09.01', CropName: '胡蘿蔔', Avg_Price: 30, Trans_Quantity: 100 },
      ],
      { official: '蘿蔔' },
    ).map((r) => r.CropName)).toEqual(['蘿蔔-白']);
  });

  it('refuses to touch a GAS service, so a stub can never fake data', () => {
    expect(() => loadBackend().retailBand(10, '甘藍', '葉菜類')).not.toThrow();
    // UrlFetchApp is stubbed to throw: the tool fetches with node's fetch and
    // must never accidentally drive the backend's own network path.
    expect(() => loadBackend().categoryOf('甘藍')).not.toThrow();
  });
});

describe('the crop def a root is joined against', () => {
  it('inherits the board item\'s guards when the root has exactly one card', () => {
    const backend = loadBackend();
    expect(defForRoot(backend, '蘿蔔').excludes).toEqual(['甜菜根', '櫻桃']);
    expect(defForRoot(backend, '柿子').excludes).toEqual(['柿餅']);
  });

  it('fits the whole root when several cards share it', () => {
    const backend = loadBackend();
    // 花椰菜 feeds both 白花椰菜 and 青花菜; no single variety filter serves the
    // one markup they share, so the fit uses the root's blended wholesale.
    const def = defForRoot(backend, '花椰菜');
    expect(def.variety).toBeUndefined();
    expect(def.category).toBe('葉菜類');
  });

  it('takes a named card when the retail row names the variety', () => {
    const backend = loadBackend();
    expect(defForRoot(backend, '雜柑', '檸檬').variety).toBe('檸檬');
    expect(defForRoot(backend, '青蔥', '蔥').excludes).toEqual(['紅蔥頭']);
    expect(() => defForRoot(backend, '雜柑', '柳丁')).toThrow(/not defined on root/);
  });
});

describe('the Taichung daily feed', () => {
  const rows = fixture('taichung-sample.json') as TaichungRow[];

  it('melts the wide sheet into dated quotes and drops the "0" non-surveys', () => {
    const { quotes } = meltTaichung(rows);
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((q) => /^\d{4}-\d{2}-\d{2}$/.test(q.date))).toBe(true);
    expect(quotes.every((q) => q.price > 0)).toBe(true);
    // 甘藍 is surveyed at three of the four markets on the first day and "0"
    // (not surveyed) at the fourth.
    const cabbage = quotes.filter((q) => q.root === '甘藍' && q.date === '2026-09-01');
    expect(cabbage).toHaveLength(3);
    expect(cabbage.map((q) => q.price).sort((a, b) => a - b)).toEqual([27, 30, 65]);
  });

  it('maps a column name to the MOA root, not to itself', () => {
    const { quotes } = meltTaichung(rows);
    const roots = new Set(quotes.map((q) => q.root));
    expect(roots.has('包心白菜')).toBe(true); // 結球白菜(山東白)
    expect(roots.has('蕹菜')).toBe(true); // 蕹菜(空心菜)
    expect(roots.has('結球白菜(山東白)')).toBe(false);
  });

  it('carries the variety hint the board filters on', () => {
    const { quotes } = meltTaichung(rows);
    expect(quotes.filter((q) => q.root === '雜柑').every((q) => q.item === '檸檬')).toBe(true);
    expect(quotes.find((q) => q.root === '甘藍')?.item).toBeUndefined();
  });

  it('leaves the meat and egg columns out without calling them unmapped', () => {
    const { quotes, unmapped } = meltTaichung(rows);
    expect(quotes.some((q) => q.root === '雞蛋')).toBe(false);
    expect(unmapped).toEqual([]);
  });

  it('reports a column it has never seen, instead of dropping it silently', () => {
    const { unmapped } = meltTaichung([{ ...rows[0], '新水果': '99' }]);
    expect(unmapped).toEqual(['新水果']);
  });

  it('maps every column to a real MOA root that the board serves', () => {
    const backend = loadBackend();
    const boardRoots = new Set(backend.boardRoots());
    for (const [column, mapped] of Object.entries(COLUMN_TO_ROOT)) {
      expect(boardRoots.has(mapped.root), `${column} → ${mapped.root}`).toBe(true);
      expect(() => defForRoot(backend, mapped.root, mapped.item)).not.toThrow();
    }
  });

  it('never both maps and ignores a column', () => {
    expect(Object.keys(COLUMN_TO_ROOT).filter((c) => IGNORED_COLUMNS[c])).toEqual([]);
  });
});

describe('the Taipei monthly feed', () => {
  const payload = fixture('taipei-month.json') as { result: { results: Record<string, unknown>[] } };

  it('dates a month\'s quotes to the first of that month', () => {
    const quotes = meltTaipeiMonth('2025-12', payload.result.results);
    expect(quotes.length).toBeGreaterThan(0);
    expect(new Set(quotes.map((q) => q.date))).toEqual(new Set(['2025-12-01']));
  });

  it('drops the "-" that marks an out-of-season item', () => {
    const quotes = meltTaipeiMonth('2025-12', payload.result.results);
    // 龍眼(大粒) and 枇杷 are published as "-" in December.
    expect(quotes.some((q) => q.root === '龍眼')).toBe(false);
    expect(quotes.some((q) => q.root === '枇杷')).toBe(false);
    expect(quotes.every((q) => q.price > 0)).toBe(true);
  });

  it('collapses two cultivar rows onto the one root they share', () => {
    const quotes = meltTaipeiMonth('2025-12', payload.result.results);
    // 綠竹筍 and 麻竹筍 are both 竹筍; 豌豆 and 甜豌豆 are both 豌豆.
    expect(quotes.filter((q) => q.root === '竹筍')).toHaveLength(2);
    expect(quotes.filter((q) => q.root === '豌豆')).toHaveLength(2);
  });

  it('reports an item it has never seen', () => {
    const items = payload.result.results.map((r) => String(r['項目']));
    expect(unmappedItems(items)).toEqual([]);
    expect(unmappedItems([...items, '新蔬菜'])).toEqual(['新蔬菜']);
  });

  it('maps every item to a real MOA root that the board serves', () => {
    const backend = loadBackend();
    const boardRoots = new Set(backend.boardRoots());
    for (const [item, mapped] of Object.entries(ITEM_TO_ROOT)) {
      expect(boardRoots.has(mapped.root), `${item} → ${mapped.root}`).toBe(true);
      expect(() => defForRoot(backend, mapped.root, mapped.item)).not.toThrow();
    }
  });

  it('never both maps and ignores an item', () => {
    expect(Object.keys(ITEM_TO_ROOT).filter((i) => IGNORED_ITEMS[i])).toEqual([]);
  });
});

describe('the Taipei resource list', () => {
  it('pairs each UUID with the nearest ROC month label', () => {
    const html = `<table>
      <tr><td>114年12月份公有零售市場行情</td><td><a href="/download?rid=aaaaaaaa-1111-2222-3333-444444444444">下載</a></td></tr>
      <tr><td>113年7月份公有零售市場行情</td><td><a href="/download?rid=bbbbbbbb-1111-2222-3333-444444444444">下載</a></td></tr>
    </table>`;
    expect(parseResources(html)).toEqual([
      { month: '2025-12', rid: 'aaaaaaaa-1111-2222-3333-444444444444' },
      { month: '2024-07', rid: 'bbbbbbbb-1111-2222-3333-444444444444' },
    ]);
  });

  it('keeps the first rid for a month and ignores the payload\'s duplicate', () => {
    // The page serialises every rid twice; the second copy sits inside a Nuxt
    // payload beside an unrelated label, and answers the data API with nothing.
    const html = `<td>114年12月份</td><a rid="aaaaaaaa-1111-2222-3333-444444444444"></a>` +
      `<script>{"file":"114年12月份","rid":"cccccccc-1111-2222-3333-444444444444"}</script>`;
    expect(parseResources(html)).toEqual([
      { month: '2025-12', rid: 'aaaaaaaa-1111-2222-3333-444444444444' },
    ]);
  });

  it('ignores the dataset\'s own id and any uuid with no month near it', () => {
    const html = `<a>${DATASET_ID}</a><a>dddddddd-1111-2222-3333-444444444444</a>`;
    expect(parseResources(html)).toEqual([]);
  });

  it('has a committed fallback covering at least a year of months', () => {
    const resources = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as MonthlyResource[];
    expect(resources.length).toBeGreaterThanOrEqual(MIN_RESOURCES);
    expect(new Set(resources.map((r) => r.rid)).size).toBe(resources.length);
    expect(new Set(resources.map((r) => r.month)).size).toBe(resources.length);
    expect(resources.every((r) => /^\d{4}-(0[1-9]|1[0-2])$/.test(r.month))).toBe(true);
    // Newest first, so the report and the log read in the order a human expects.
    expect(resources.map((r) => r.month)).toEqual([...resources.map((r) => r.month)].sort().reverse());
  });
});

describe('the MOA request plan', () => {
  it('covers every needed date with as few windows as possible', () => {
    expect(coverWindows(['2026-01-01', '2026-01-05', '2026-01-12'], 12))
      .toEqual([{ from: '2026-01-01', to: '2026-01-12' }]);
    expect(coverWindows(['2026-01-01', '2026-01-13'], 12)).toEqual([
      { from: '2026-01-01', to: '2026-01-12' },
      { from: '2026-01-13', to: '2026-01-24' },
    ]);
  });

  it('skips the months a seasonal crop is never surveyed in', () => {
    // A citrus surveyed only in January and March costs two windows, not the
    // eight a contiguous January-to-March range would.
    const plan = coverWindows(['2026-01-05', '2026-03-05'], 12);
    expect(plan).toHaveLength(2);
    expect(plan[0].from).toBe('2026-01-05');
    expect(plan[1].from).toBe('2026-03-05');
  });

  it('asks for nothing when there is nothing to join', () => {
    expect(coverWindows([], 12)).toEqual([]);
  });

  it('spans a month boundary correctly', () => {
    expect(coverWindows(['2026-02-25'], 12)).toEqual([{ from: '2026-02-25', to: '2026-03-08' }]);
  });
});

describe('the wholesale side', () => {
  const payload = fixture('moa-sample.json') as { Data: MoaRow[] };

  it('is the board\'s own daily blended catty price', () => {
    const backend = loadBackend();
    const days = dailyWholesale(payload.Data, { official: '甘藍' });
    expect(days.length).toBeGreaterThan(0);
    expect(days.map((d) => d.date)).toEqual([...days.map((d) => d.date)].sort());

    const first = days[0];
    const rows = backend.selectRows(payload.Data, { official: '甘藍' })
      .filter((r) => backend.rocToISO(r.TransDate) === first.date);
    expect(first.catty).toBeCloseTo(backend.weightedAverage(rows).avg * backend.CATTY_PER_KG, 10);
  });

  it('drops 休市 placeholders and the root\'s substring neighbours', () => {
    // The fixture carries a 休市 row and a 甘藍芽 row: neither is 甘藍.
    const names = new Set(loadBackend().selectRows(payload.Data, { official: '甘藍' }).map((r) => r.CropName));
    expect([...names].every((n) => n.startsWith('甘藍-'))).toBe(true);
  });

  it('drops a day the board would not publish a card for', () => {
    const thin: MoaRow[] = [
      { TransDate: '115.09.01', CropName: '甘藍-初秋', MarketName: '台北一', Avg_Price: 20, Trans_Quantity: 10 },
    ];
    expect(dailyWholesale(thin, { official: '甘藍' })).toEqual([]);
  });
});
