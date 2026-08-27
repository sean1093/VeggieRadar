/**
 * Regression tests for backend/Code.gs.
 *
 * `frontend/` owns the only test runner in the repo, so the Apps Script source
 * is loaded here and evaluated with stubbed GAS services. These lock down the
 * two MOA quirks that previously produced wrong prices in production:
 *
 *   - `CropName` matches as a SUBSTRING of `<root>-<variety>`, so a query for
 *     蘿蔔 also returns 胡蘿蔔, 胡瓜 also returns 花胡瓜, and 青蔥 also returns 洋蔥.
 *   - Closed markets (and today, before closing prices publish) come back as
 *     `CropName: "休市"` rows with zero price/quantity.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Row = {
  CropName: string;
  CropCode?: string;
  MarketName?: string;
  Avg_Price: number;
  Trans_Quantity: number;
};

const SOURCE = readFileSync(resolve(__dirname, '../backend/Code.gs'), 'utf8');

/** Loads Code.gs with stubbed GAS globals. `responses` maps URL → rows. */
function loadBackend(responses: Record<string, Row[]> = {}) {
  const logs: string[] = [];
  const props = new Map<string, string>();
  const cache = new Map<string, string>();

  const respond = (url: string) => {
    const hit = Object.keys(responses).find((key) => url.includes(encodeURIComponent(key)));
    const rows = hit ? responses[hit] : [];
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ RS: 'OK', Data: rows }),
    };
  };

  const services = {
    UrlFetchApp: {
      fetch: (url: string) => respond(url),
      fetchAll: (reqs: { url: string }[]) => reqs.map((r) => respond(r.url)),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k: string) => cache.get(k) ?? null,
        put: (k: string, v: string) => void cache.set(k, v),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => props.get(k) ?? null,
        setProperty: (k: string, v: string) => void props.set(k, v),
        setProperties: (o: Record<string, string>) =>
          void Object.entries(o).forEach(([k, v]) => props.set(k, v)),
        deleteProperty: (k: string) => void props.delete(k),
        getProperties: () => Object.fromEntries(props),
      }),
    },
    Logger: { log: (m: unknown) => void logs.push(String(m)) },
    Utilities: { sleep: () => {} },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t: string) => ({ setMimeType: () => ({ body: t }) }),
    },
    ScriptApp: { getProjectTriggers: () => [] },
  };

  const exported = [
    'tradedRows', 'selectRows', 'rowRoot', 'rowVariety', 'isTradingDate',
    'retailBand', 'aggregateGroup', 'boardRoots', 'BOARD_ITEMS',
    'RETAIL_MARKUP_ROOT', 'RETAIL_MARKUP_CATEGORY', 'storeBoard', 'readDurableBoard',
  ];
  const factory = new Function(
    ...Object.keys(services),
    `${SOURCE}\nreturn { ${exported.join(', ')} };`,
  );
  return { api: factory(...Object.values(services)), logs, props };
}

const row = (CropName: string, Avg_Price: number, Trans_Quantity: number, MarketName = '台北一'): Row =>
  ({ CropName, Avg_Price, Trans_Quantity, MarketName, CropCode: 'X1' });

describe('tradedRows', () => {
  it('drops 休市 placeholders and zero-quantity rows', () => {
    const { api } = loadBackend();
    const rows = [
      row('休市', 0, 0),
      row('甘藍-初秋', 0, 500),
      row('甘藍-初秋', 20, 0),
      row('甘藍-初秋', 22.5, 1200),
    ];
    expect(api.tradedRows(rows)).toEqual([rows[3]]);
  });
});

describe('selectRows — root isolation', () => {
  const { api } = loadBackend();
  const find = (name: string) => {
    const def = api.BOARD_ITEMS.find((d: { name: string }) => d.name === name);
    if (!def) throw new Error(`no board item named ${name}`);
    return def;
  };

  it('白蘿蔔 excludes 胡蘿蔔 and 蘿蔔乾', () => {
    const rows = [
      row('蘿蔔-進口', 24, 109906),
      row('蘿蔔-矸仔', 25, 34772),
      row('胡蘿蔔-清洗', 20, 95213),
      row('蘿蔔乾', 90, 1066),
      row('蘿蔔-甜菜根', 60, 350),
    ];
    const kept = api.selectRows(rows, find('白蘿蔔')).map((r: Row) => r.CropName);
    expect(kept).toEqual(['蘿蔔-進口', '蘿蔔-矸仔']);
  });

  it('大黃瓜 excludes 花胡瓜 (小黃瓜) and 小黃瓜 excludes 胡瓜', () => {
    const rows = [row('胡瓜-黑刺', 28.5, 43990), row('花胡瓜', 73.6, 64667), row('花胡瓜-其他', 70, 3047)];
    expect(api.selectRows(rows, find('大黃瓜')).map((r: Row) => r.CropName)).toEqual(['胡瓜-黑刺']);
    expect(api.selectRows(rows, find('小黃瓜')).map((r: Row) => r.CropName)).toEqual(['花胡瓜', '花胡瓜-其他']);
  });

  it('蔥 excludes 洋蔥, 大蒜-蔥蒜 and 紅蔥頭', () => {
    const rows = [
      row('青蔥-粉蔥', 80, 41552),
      row('青蔥-北蔥', 75, 10772),
      row('洋蔥-本產', 20, 41635),
      row('大蒜-蔥蒜', 60, 835),
      row('青蔥-紅蔥頭', 85, 788),
    ];
    expect(api.selectRows(rows, find('蔥')).map((r: Row) => r.CropName)).toEqual(['青蔥-粉蔥', '青蔥-北蔥']);
    expect(api.selectRows(rows, find('紅蔥頭')).map((r: Row) => r.CropName)).toEqual(['青蔥-紅蔥頭']);
  });

  it('薑 excludes the ornamental ginger flowers', () => {
    const rows = [row('薑-嫩薑', 90, 9045), row('薑荷花', 300, 114), row('野薑花-白', 250, 11)];
    expect(api.selectRows(rows, find('薑')).map((r: Row) => r.CropName)).toEqual(['薑-嫩薑']);
  });

  it('青椒 and 甜椒 partition the 甜椒 root instead of overlapping', () => {
    const rows = [row('甜椒-青椒', 41, 30096), row('甜椒-彩色種 紅色', 120, 11004)];
    expect(api.selectRows(rows, find('青椒')).map((r: Row) => r.CropName)).toEqual(['甜椒-青椒']);
    expect(api.selectRows(rows, find('甜椒')).map((r: Row) => r.CropName)).toEqual(['甜椒-彩色種 紅色']);
  });

  it('玉米 and 玉米筍 partition the 玉米 root', () => {
    const rows = [
      row('玉米-甜軟殼', 35, 34721),
      row('玉米-進口 玉米筍', 45, 16995),
      row('玉米-玉米筍 帶殼', 44, 6418),
    ];
    expect(api.selectRows(rows, find('玉米')).map((r: Row) => r.CropName)).toEqual(['玉米-甜軟殼']);
    expect(api.selectRows(rows, find('玉米筍')).map((r: Row) => r.CropName)).toEqual([
      '玉米-進口 玉米筍',
      '玉米-玉米筍 帶殼',
    ]);
  });

  it('番茄 excludes 小番茄, and 木瓜 / 西瓜 / 鳳梨 exclude look-alike roots', () => {
    expect(
      api.selectRows([row('番茄-牛番茄', 84, 98759), row('小番茄-聖女', 104, 20741)], find('番茄'))
        .map((r: Row) => r.CropName),
    ).toEqual(['番茄-牛番茄']);
    expect(
      api.selectRows([row('木瓜-網室紅肉', 31, 144779), row('南瓜-木瓜型 阿成', 25, 7458)], find('木瓜'))
        .map((r: Row) => r.CropName),
    ).toEqual(['木瓜-網室紅肉']);
    expect(
      api.selectRows([row('西瓜-黃肉', 13, 129569), row('鳳梨-西瓜鳳梨', 30, 9846)], find('西瓜'))
        .map((r: Row) => r.CropName),
    ).toEqual(['西瓜-黃肉']);
    expect(
      api.selectRows([row('鳳梨-金鑽鳳梨', 35, 78796), row('珊瑚鳳梨', 200, 187)], find('鳳梨'))
        .map((r: Row) => r.CropName),
    ).toEqual(['鳳梨-金鑽鳳梨']);
  });

  it('檸檬 keeps only the 檸檬 varieties of the 雜柑 root', () => {
    const rows = [
      row('雜柑-檸檬', 40, 10455),
      row('雜柑-無子檸檬', 38, 5058),
      row('雜柑-桔子', 60, 1065),
      row('檸檬綠文心蘭', 500, 992),
    ];
    expect(api.selectRows(rows, find('檸檬')).map((r: Row) => r.CropName)).toEqual(['雜柑-檸檬', '雜柑-無子檸檬']);
  });
});

describe('isTradingDate', () => {
  it('rejects a day whose only rows are 休市 placeholders', () => {
    const { api } = loadBackend({ 甘藍: [row('休市', 0, 0), row('休市', 0, 0)] });
    expect(api.isTradingDate('甘藍', '115.08.27')).toBe(false);
  });

  it('rejects a barely-open day below the island-wide volume floor', () => {
    const { api } = loadBackend({ 甘藍: [row('甘藍-初秋', 22, 10283)] });
    expect(api.isTradingDate('甘藍', '115.08.24')).toBe(false);
  });

  it('accepts a real trading day', () => {
    const { api } = loadBackend({ 甘藍: [row('甘藍-初秋', 22, 640155)] });
    expect(api.isTradingDate('甘藍', '115.08.26')).toBe(true);
  });
});

describe('retailBand', () => {
  const { api } = loadBackend();

  it('uses the calibrated per-root markup and rounds the band outward to NT$5', () => {
    // 甘藍 markup 29 → low 14 + 21.75 = 35.75 → 35; high 14 + 39.15 = 53.15 → 55
    expect(api.retailBand(14, '甘藍', '葉菜類')).toEqual({ low: 35, mid: 43, high: 55 });
  });

  it('falls back to the category band for an uncalibrated root', () => {
    const [low, mid, high] = api.RETAIL_MARKUP_CATEGORY['菇類'];
    const band = api.retailBand(20, '杏鮑菇', '菇類');
    expect(band.mid).toBe(Math.round(20 + mid));
    expect(band.low).toBe(Math.floor((20 + low) / 5) * 5);
    expect(band.high).toBe(Math.ceil((20 + high) / 5) * 5);
  });

  it('never returns a band that straddles or undercuts the wholesale price', () => {
    for (const def of api.BOARD_ITEMS) {
      for (const catty of [5, 20, 60, 200]) {
        const b = api.retailBand(catty, def.official, def.category);
        expect(b.low).toBeGreaterThan(catty);
        expect(b.mid).toBeGreaterThanOrEqual(b.low);
        expect(b.high).toBeGreaterThanOrEqual(b.mid);
      }
    }
  });
});

describe('board definition integrity', () => {
  const { api } = loadBackend();

  it('deduplicates MOA requests by root', () => {
    const roots: string[] = api.boardRoots();
    expect(new Set(roots).size).toBe(roots.length);
    expect(roots.length).toBeLessThan(api.BOARD_ITEMS.length);
  });

  it('gives every item a unique display name and a known category', () => {
    const names = api.BOARD_ITEMS.map((d: { name: string }) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const def of api.BOARD_ITEMS) {
      expect(api.RETAIL_MARKUP_CATEGORY[def.category]).toBeDefined();
    }
  });

  it('never lets two items claim the same row of a shared root', () => {
    type Def = { name: string; official: string; variety?: string; excludes?: string[] };
    const byRoot: Record<string, Def[]> = {};
    for (const def of api.BOARD_ITEMS as Def[]) (byRoot[def.official] ??= []).push(def);

    for (const [root, defs] of Object.entries(byRoot)) {
      if (defs.length < 2) continue;
      // Every variety token either side of the partition, plus an unlisted one.
      const varieties = [
        ...defs.flatMap((d) => [d.variety, ...(d.excludes ?? [])]).filter((v): v is string => !!v),
        '其他',
      ];
      for (const variety of varieties) {
        const candidate = row(`${root}-${variety}`, 50, 5000);
        const claimedBy = defs.filter((d) => api.selectRows([candidate], d).length > 0);
        expect(claimedBy.map((d) => d.name).length, `${root}-${variety} claimed by ${claimedBy.map((d) => d.name)}`)
          .toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('storeBoard / readDurableBoard', () => {
  it('round-trips a board larger than the 9 KB ScriptProperties value cap', () => {
    const { api, props } = loadBackend();
    const board = {
      type: 'board',
      date: '2026-08-26',
      count: 94,
      items: Array.from({ length: 94 }, (_, i) => ({
        code: `C${i}`, name: `品項${i}`, official_name: `官方${i}`, category: '葉菜類',
        avg_price: 20 + i, catty_price: 12 + i, retail_low: 30, retail_price: 40, retail_high: 55,
        retail_estimated: true, change_percent: -1.5, trade_volume: 12345, unit: '公斤', markets_count: 8,
      })),
    };
    const json = JSON.stringify(board);
    expect(json.length).toBeGreaterThan(9000);

    api.storeBoard(board);
    expect(Number(props.get('veggie_board_v2_chunks'))).toBeGreaterThan(1);
    expect(api.readDurableBoard()).toBe(json);
  });

  it('clears chunks left over from a previously larger board', () => {
    const { api, props } = loadBackend();
    const big = { type: 'board', items: Array.from({ length: 200 }, (_, i) => ({ i, pad: 'x'.repeat(80) })) };
    api.storeBoard(big);
    const bigChunks = Number(props.get('veggie_board_v2_chunks'));
    expect(bigChunks).toBeGreaterThan(2);

    const small = { type: 'board', items: [{ i: 1 }] };
    api.storeBoard(small);
    expect(Number(props.get('veggie_board_v2_chunks'))).toBe(1);
    expect(props.has('veggie_board_v2_chunk_1')).toBe(false);
    expect(api.readDurableBoard()).toBe(JSON.stringify(small));
  });
});
