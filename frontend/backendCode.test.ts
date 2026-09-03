/**
 * Regression tests for the Apps Script backend (`backend/*.gs`).
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
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

type Row = {
  CropName: string;
  CropCode?: string;
  MarketName?: string;
  Avg_Price: number;
  Trans_Quantity: number;
  TransDate?: string;
};

// Apps Script merges every .gs file into ONE global scope, so the tests compose
// them the same way. Read from disk rather than from a manifest: `.clasp.json`
// has no ordering key on purpose — no top-level initialiser here depends on
// another file (a test below enforces that), so load order cannot matter, and a
// config key whose semantics are relative to `rootDir` would only add a way to
// be wrong. Reading the directory also covers a new backend file automatically
// instead of leaving it silently untested.
const BACKEND_DIR = resolve(__dirname, '../backend');
const GS_FILES = readdirSync(BACKEND_DIR).filter((f) => f.endsWith('.gs')).sort();
const SOURCE = GS_FILES.map((f) => readFileSync(resolve(BACKEND_DIR, f), 'utf8')).join('\n');

/** Loads the backend with stubbed GAS globals. `responses` maps URL → rows. */
function loadBackend(responses: Record<string, Row[]> = {}) {
  const logs: string[] = [];
  const props = new Map<string, string>();
  const cache = new Map<string, string>();
  const triggers: { handler: string; kind: string }[] = [];
  const fetches: string[] = [];
  const locks = { waits: 0, tries: 0, releases: 0, contended: false };
  const mails: { to: string; subject: string; body: string }[] = [];
  let mailThrows = false;
  let brokenPropKey: string | null = null;

  const respond = (url: string) => {
    fetches.push(url);
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
        remove: (k: string) => void cache.delete(k),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => props.get(k) ?? null,
        setProperty: (k: string, v: string) => {
          if (k === brokenPropKey) throw new Error('properties service unavailable');
          props.set(k, v);
        },
        setProperties: (o: Record<string, string>) =>
          void Object.entries(o).forEach(([k, v]) => props.set(k, v)),
        deleteProperty: (k: string) => void props.delete(k),
        getProperties: () => Object.fromEntries(props),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: (_ms: number) => void (locks.waits += 1),
        tryLock: (_ms: number) => {
          locks.tries += 1;
          return !locks.contended;
        },
        releaseLock: () => void (locks.releases += 1),
      }),
    },
    MailApp: {
      sendEmail: (to: string, subject: string, body: string) => {
        if (mailThrows) throw new Error('mail quota exceeded');
        mails.push({ to, subject, body });
      },
    },
    Logger: { log: (m: unknown) => void logs.push(String(m)) },
    Utilities: { sleep: () => {} },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t: string) => ({ setMimeType: () => ({ body: t }) }),
    },
    ScriptApp: {
      getProjectTriggers: () =>
        triggers.map((t) => ({
          getHandlerFunction: () => t.handler,
          getUniqueId: () => `${t.handler}:${t.kind}`,
        })),
      deleteTrigger: (t: { getHandlerFunction: () => string }) => {
        const i = triggers.findIndex((x) => x.handler === t.getHandlerFunction());
        if (i >= 0) triggers.splice(i, 1);
      },
      newTrigger: (handler: string) => {
        const spec = { handler, kind: 'unset' };
        const clock = {
          after: (ms: number) => ((spec.kind = `after:${ms}`), clock),
          everyHours: (h: number) => ((spec.kind = `everyHours:${h}`), clock),
          create: () => void triggers.push(spec),
        };
        return { timeBased: () => clock };
      },
    },
  };

  const exported = [
    'tradedRows', 'selectRows', 'rowRoot', 'rowVariety', 'isTradingDate',
    'retailBand', 'aggregateGroup', 'boardRoots', 'BOARD_ITEMS',
    'RETAIL_MARKUP_ROOT', 'RETAIL_MARKUP_CATEGORY', 'storeBoard', 'readDurableBoard',
    'readBoard', 'boardAgeMs', 'scheduleRefresh', 'dropTriggers', 'handleWarm',
    'handleDiag', 'BOARD_MAX_AGE_MS', 'REFRESH_ONCE_FN',
    'handleTrend', 'resolveTradeDates',
    'median', 'appendObservation', 'updateHistory', 'readHistory', 'writeHistory',
    'applyBaselines', 'backfillHistory', 'handleBackfill', 'buildBoard',
    'BASELINE_WINDOW', 'BASELINE_MIN_DAYS', 'varietyBreakdown', 'handleSearch', 'RETAIL_BAND_ROOT',
    'sendAlert', 'recordRefreshOutcome', 'withAlertLock', 'handleAlertTest',
    'ALERT_EMAIL', 'ALERT_FAILURE_STREAK', 'ALERT_SILENCE_MS', 'ALERT_COOLDOWN_MS',
    'REFRESH_INTERVAL_HOURS', 'installDailyTrigger', 'refreshBoardCache',
  ];
  const factory = new Function(
    ...Object.keys(services),
    `${SOURCE}\nreturn { ${exported.join(', ')} };`,
  );
  return {
    api: factory(...Object.values(services)),
    logs, props, cache, triggers, fetches, locks, mails,
    breakMail: () => { mailThrows = true; },
    fixMail: () => { mailThrows = false; },
    breakProp: (key: string) => { brokenPropKey = key; },
    contendLock: () => { locks.contended = true; },
  };
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

  it('prefers a fitted per-crop band over the category fallback', () => {
    // 番茄 has no tier-1 markup but does have a fitted [53, 59, 68] band, and
    // the 果菜類 fallback would say [48, 70, 88] — a different, much wider band.
    const band = api.retailBand(30, '番茄', '果菜類');
    expect(band).toEqual({ low: 80, mid: 89, high: 100 });
    expect(band).not.toEqual(
      api.retailBand(30, '沒有校準的菜', '果菜類'),
    );
  });

  it('falls back to the category band for a crop in neither table', () => {
    const [low, mid, high] = api.RETAIL_MARKUP_CATEGORY['菇類'];
    const band = api.retailBand(20, '杏鮑菇', '菇類');
    expect(band.mid).toBe(Math.round(20 + mid));
    expect(band.low).toBe(Math.floor((20 + low) / 5) * 5);
    expect(band.high).toBe(Math.ceil((20 + high) / 5) * 5);
  });

  it('keeps tier 1 winning over tier 2 for crops in both', () => {
    // The 30 originally calibrated crops are deliberately untouched: the
    // holdout comparison for them is contaminated (they were fitted on a
    // window that includes it), so there is no evidence a refit is better.
    const both = Object.keys(api.RETAIL_MARKUP_ROOT).filter((r) => api.RETAIL_BAND_ROOT[r]);
    expect(both).toEqual([]);
  });

  it('only publishes a per-crop band that is tighter than the fallback it replaces', () => {
    // A wider band would be less informative than the category default, which
    // is the whole reason 竹筍, 蘆筍, 菠菜, 芹菜, 萵苣菜 and 李 are excluded.
    for (const [root, band] of Object.entries(api.RETAIL_BAND_ROOT) as [string, number[]][]) {
      const def = api.BOARD_ITEMS.find((d: { official: string }) => d.official === root);
      expect(def, `${root} must be a board crop`).toBeDefined();
      const cat = api.RETAIL_MARKUP_CATEGORY[def.category];
      expect(band[2] - band[0], `${root} band wider than ${def.category}`).toBeLessThanOrEqual(cat[2] - cat[0]);
      expect(band[0]).toBeGreaterThan(0);
      expect(band[0]).toBeLessThan(band[1]);
      expect(band[1]).toBeLessThan(band[2]);
    }
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

/**
 * The board's trading date legitimately stands still (weekends, holidays, typhoon
 * closures — MOA then publishes only 休市 rows). What must never stand still is
 * `generated_at`. These lock down the freshness contract the UI reads, plus the
 * self-heal that stopped a dead refresh trigger from freezing the app on an old date.
 */
describe('readBoard freshness', () => {
  const storedBoard = (generatedAt: string | null) => {
    const board: Record<string, unknown> = {
      type: 'board',
      date: '2026-08-26',
      roc_date: '115.08.26',
      count: 1,
      items: [{ code: 'C1', name: '高麗菜' }],
    };
    if (generatedAt) board.generated_at = generatedAt;
    return board;
  };

  it('marks a freshly built board fresh and queues nothing', () => {
    const { api, triggers } = loadBackend();
    api.storeBoard(storedBoard(new Date().toISOString()));

    const board = api.readBoard();
    expect(board.stale).toBe(false);
    expect(board.cached).toBe(true);
    expect(board.age_ms).toBeLessThan(api.BOARD_MAX_AGE_MS);
    expect(triggers).toHaveLength(0);
  });

  it('keeps serving a stale board but queues a background rebuild', () => {
    const { api, triggers } = loadBackend();
    const old = new Date(Date.now() - api.BOARD_MAX_AGE_MS - 60_000).toISOString();
    api.storeBoard(storedBoard(old));

    const board = api.readBoard();
    expect(board.stale).toBe(true);
    expect(board.refresh_queued).toBe(true);
    // Prices still render; a stale board beats an empty one.
    expect(board.date).toBe('2026-08-26');
    expect(board.items).toHaveLength(1);
    expect(triggers).toEqual([{ handler: api.REFRESH_ONCE_FN, kind: 'after:1000' }]);
  });

  it('treats a board with no generated_at as stale — its real age is unknown', () => {
    const { api } = loadBackend();
    api.storeBoard(storedBoard(null));

    const board = api.readBoard();
    expect(board.age_ms).toBeNull();
    expect(board.stale).toBe(true);
    expect(board.refresh_queued).toBe(true);
  });

  it('queues one rebuild per lock window, not one per request', () => {
    const { api, triggers } = loadBackend();
    api.storeBoard(storedBoard(null));

    expect(api.readBoard().refresh_queued).toBe(true);
    expect(api.readBoard().refresh_queued).toBe(false);
    expect(api.readBoard().refresh_queued).toBe(false);
    expect(triggers).toHaveLength(1);
  });

  it('reports warming when nothing is stored yet', () => {
    const { api, triggers } = loadBackend();
    const board = api.readBoard();
    expect(board.warming).toBe(true);
    expect(board.stale).toBe(true);
    expect(board.items).toEqual([]);
    expect(triggers).toHaveLength(1);
  });
});

describe('refresh scheduling', () => {
  it('never deletes the recurring trigger when pruning one-off ones', () => {
    const { api, triggers } = loadBackend();
    triggers.push({ handler: 'refreshBoardCache', kind: 'everyHours:4' });

    api.scheduleRefresh();
    expect(triggers.map((t) => t.handler)).toEqual(['refreshBoardCache', api.REFRESH_ONCE_FN]);

    expect(api.dropTriggers(api.REFRESH_ONCE_FN)).toBe(1);
    expect(triggers.map((t) => t.handler)).toEqual(['refreshBoardCache']);
  });

  it('answers ?action=warm immediately instead of crawling', () => {
    const { api } = loadBackend();
    api.storeBoard({ type: 'board', date: '2026-08-26', roc_date: '115.08.26', count: 1, items: [{ code: 'C1' }] });

    const first = api.handleWarm({});
    expect(first).toMatchObject({ type: 'warm', queued: true });
    expect(first.board).toMatchObject({ date: '2026-08-26', stale: true, count: 1 });

    expect(api.handleWarm({}).queued).toBe(false);
    // force jumps the lock so a stuck refresh can be retried by hand.
    expect(api.handleWarm({ force: '1' }).queued).toBe(true);
  });

  it('surfaces trigger state and last refresh outcome via ?action=diag', () => {
    const { api, props, triggers } = loadBackend();
    triggers.push({ handler: 'refreshBoardCache', kind: 'everyHours:4' });
    props.set('veggie_last_refresh_ok', '2026-08-28T00:10:00.000Z 115.08.26 94 items');

    const diag = api.handleDiag();
    expect(diag.type).toBe('diag');
    expect(diag.triggers).toEqual(['refreshBoardCache']);
    expect(diag.last_refresh_ok).toContain('115.08.26');
    expect(diag.last_refresh_fail).toBeNull();
    expect(diag.board_items_configured).toBe(api.BOARD_ITEMS.length);
  });
});
/** ROC-calendar date string for `daysAgo` days before today (local time). */
const rocDate = (daysAgo: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear() - 1911}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
};

const trendRow = (
  TransDate: string,
  CropName: string,
  Avg_Price: number,
  Trans_Quantity: number,
  MarketName = '台北一',
): Row => ({ CropName, Avg_Price, Trans_Quantity, MarketName, CropCode: 'X1', TransDate });

/**
 * The trend used to crawl one MOA request per calendar day (7 fetches + sleeps
 * per drawer open). It must now cost ONE range request, keep the same response
 * shape, and be served from the shared cache so trend load stops scaling with
 * user traffic — that is what protects the URLFetch daily quota and the
 * 30-simultaneous-execution cap.
 */
describe('handleTrend — cached range query', () => {
  it('crawls the whole window with one range fetch, weights by volume, nulls closed days', () => {
    const { api, fetches } = loadBackend({
      蘿蔔: [
        trendRow(rocDate(1), '蘿蔔-白', 10, 1000),
        trendRow(rocDate(1), '蘿蔔-白', 20, 3000, '台中'),
        trendRow(rocDate(3), '蘿蔔-白', 30, 500),
        trendRow(rocDate(2), '休市', 0, 0),
        // Substring pollution: querying 蘿蔔 also returns 胡蘿蔔 — must not
        // leak into the 蘿蔔 trend.
        trendRow(rocDate(1), '胡蘿蔔-清洗', 99, 50000),
      ],
    });

    const res = api.handleTrend({ cropName: '蘿蔔', days: '7' });

    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain(`Start_time=${rocDate(6)}`);
    expect(fetches[0]).toContain(`End_time=${rocDate(0)}`);
    expect(res.trend).toHaveLength(7);
    expect(res.trend[5]).toBe(17.5); // (10×1000 + 20×3000) / 4000, yesterday
    expect(res.trend[3]).toBe(30); // three days ago
    expect(res.trend[6]).toBeNull(); // today: closing prices not published
    expect(res.trend[4]).toBeNull(); // 休市 placeholder day stays null
  });

  it('serves repeat requests from the cache without touching MOA again', () => {
    const { api, fetches } = loadBackend({
      蘿蔔: [trendRow(rocDate(1), '蘿蔔-白', 10, 1000)],
    });

    const first = api.handleTrend({ cropName: '蘿蔔', days: '7' });
    const second = api.handleTrend({ cropName: '蘿蔔', days: '7' });

    expect(fetches).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('resolves colloquial names through the alias table', () => {
    const { api, fetches } = loadBackend({ 甘藍: [] });
    api.handleTrend({ cropName: '高麗菜', days: '7' });
    expect(fetches[0]).toContain(encodeURIComponent('甘藍'));
  });

  it('clamps the window to the MOA row cap and floors bad input', () => {
    const { api, fetches } = loadBackend({ 甘藍: [] });
    expect(api.handleTrend({ cropName: '甘藍', days: '90' }).days).toBe(14);
    expect(fetches[0]).toContain(`Start_time=${rocDate(13)}`);
    expect(api.handleTrend({ cropName: '甘藍', days: 'abc' }).days).toBe(7);
  });
});

/**
 * A search miss used to spend up to 16 probe fetches inside resolveTradeDates
 * on every request. The probe answer barely moves, so it is shared through the
 * cache — but the board build must always probe fresh: a board built on a
 * stale trading date is the one failure users would actually see.
 */
describe('resolveTradeDates — probe caching', () => {
  const probeDay = (): Row[] => [row('甘藍-初秋', 20, 60000)]; // ≥ PROBE_MIN_VOLUME

  it('caches a successful probe for the search path', () => {
    const { api, fetches } = loadBackend({ 甘藍: probeDay() });

    const first = api.resolveTradeDates();
    expect(first.latest).toBe(rocDate(0));
    expect(first.prev).toBe(rocDate(1));
    const probesUsed = fetches.length;

    const second = api.resolveTradeDates();
    expect(second).toEqual(first);
    expect(fetches).toHaveLength(probesUsed); // no new MOA traffic
  });

  it('bypasses the cache when the board build asks for a fresh probe', () => {
    const { api, fetches } = loadBackend({ 甘藍: probeDay() });
    api.resolveTradeDates();
    const probesUsed = fetches.length;
    api.resolveTradeDates(true);
    expect(fetches.length).toBeGreaterThan(probesUsed);
  });

  it('never caches a failed probe, so recovery is immediate', () => {
    const { api, fetches } = loadBackend({}); // MOA down / all 休市
    expect(api.resolveTradeDates().latest).toBeNull();
    const probesUsed = fetches.length;
    api.resolveTradeDates();
    expect(fetches.length).toBe(probesUsed * 2); // probed again, not served a cached failure
  });
});
describe('median', () => {
  it('handles odd, even and single-element arrays', () => {
    const { api } = loadBackend();
    expect(api.median([3, 1, 2])).toBe(2);
    expect(api.median([4, 1, 3, 2])).toBe(2.5);
    expect(api.median([5])).toBe(5);
  });
});

describe('appendObservation — rolling per-item series', () => {
  it('appends, sorts out-of-order dates, and replaces the same trading date', () => {
    const { api } = loadBackend();
    let series = api.appendObservation(undefined, rocDate(2), 10);
    series = api.appendObservation(series, rocDate(3), 9); // arrives late, must sort in
    series = api.appendObservation(series, rocDate(2), 12); // 4-hourly refresh revisits the day
    expect(series).toEqual([
      [rocDate(3), 9],
      [rocDate(2), 12],
    ]);
  });

  it('trims to the window, dropping the oldest entries', () => {
    const { api } = loadBackend();
    let series: [string, number][] | undefined;
    const total = api.BASELINE_WINDOW + 5;
    for (let i = 0; i < total; i++) {
      series = api.appendObservation(series, rocDate(total - i), 10 + i);
    }
    expect(series).toHaveLength(api.BASELINE_WINDOW);
    expect(series![0][0]).toBe(rocDate(api.BASELINE_WINDOW)); // 5 oldest gone
    expect(series![series!.length - 1][0]).toBe(rocDate(1));
  });
});

describe('updateHistory — refresh integration', () => {
  it('records one observation per item per trading date, idempotently', () => {
    const { api } = loadBackend();
    api.updateHistory({ roc_date: rocDate(1), items: [{ name: '高麗菜', avg_price: 20 }] });
    api.updateHistory({ roc_date: rocDate(1), items: [{ name: '高麗菜', avg_price: 21 }] });
    expect(api.readHistory().items['高麗菜']).toEqual([[rocDate(1), 21]]);

    api.updateHistory({ roc_date: rocDate(0), items: [{ name: '高麗菜', avg_price: 25 }] });
    expect(api.readHistory().items['高麗菜']).toEqual([
      [rocDate(1), 21],
      [rocDate(0), 25],
    ]);
  });

  it('prunes horizon-stale entries and items that left the board definition', () => {
    const { api } = loadBackend();
    api.writeHistory({
      version: 1,
      items: {
        高麗菜: [[rocDate(60), 8], [rocDate(2), 20]],
        已下架的菜: [[rocDate(2), 99]],
      },
    });
    api.updateHistory({ roc_date: rocDate(1), items: [{ name: '高麗菜', avg_price: 22 }] });
    const items = api.readHistory().items;
    expect(items['高麗菜']).toEqual([
      [rocDate(2), 20],
      [rocDate(1), 22],
    ]);
    expect(items['已下架的菜']).toBeUndefined();
  });

  it('ignores an empty or dateless board — a failed crawl must not touch history', () => {
    const { api } = loadBackend();
    api.writeHistory({ version: 1, items: { 高麗菜: [[rocDate(2), 20]] } });
    api.updateHistory({ roc_date: null, items: [{ name: '高麗菜', avg_price: 1 }] });
    api.updateHistory({ roc_date: rocDate(1), items: [] });
    expect(api.readHistory().items['高麗菜']).toEqual([[rocDate(2), 20]]);
  });

  it('round-trips a full-size history through multi-chunk properties', () => {
    const { api, props } = loadBackend();
    for (let d = api.BASELINE_WINDOW; d >= 1; d--) {
      api.updateHistory({
        roc_date: rocDate(d),
        items: api.BOARD_ITEMS.map((def: { name: string }) => ({ name: def.name, avg_price: 20 + (d % 7) })),
      });
    }
    expect(parseInt(props.get('veggie_history_chunks') ?? '0', 10)).toBeGreaterThan(1);
    const history = api.readHistory();
    expect(Object.keys(history.items)).toHaveLength(api.BOARD_ITEMS.length);
    expect(history.items['高麗菜']).toHaveLength(api.BASELINE_WINDOW);
  });

  it('treats a corrupt store as empty instead of crashing the build', () => {
    const { api, props } = loadBackend();
    props.set('veggie_history_chunks', '1');
    props.set('veggie_history_chunk_0', '{not json');
    expect(api.readHistory()).toEqual({ version: 1, items: {} });
  });
});

describe('applyBaselines', () => {
  const flatSeries = (days: number, price: number): [string, number][] => {
    const out: [string, number][] = [];
    for (let i = days; i >= 1; i--) out.push([rocDate(i), price]);
    return out;
  };

  it('publishes the median as 元/台斤 with a signed percent', () => {
    const { api } = loadBackend();
    const series = flatSeries(12, 18).map(
      (entry, i): [string, number] => [entry[0], i < 6 ? 18 : 22], // median 20
    );
    const items = [{ name: '高麗菜', avg_price: 15 }] as Record<string, unknown>[];
    api.applyBaselines(items, { version: 1, items: { 高麗菜: series } }, rocDate(0));
    expect(items[0].baseline_price).toBe(12); // 20 元/公斤 × 0.6
    expect(items[0].vs_baseline_percent).toBe(-25);
  });

  it("excludes today's own observation — a spike day must not vouch for itself", () => {
    const { api } = loadBackend();
    const series = flatSeries(11, 20);
    series.push([rocDate(0), 1000]); // today's spike, already recorded
    const items = [{ name: '高麗菜', avg_price: 15 }] as Record<string, unknown>[];
    api.applyBaselines(items, { version: 1, items: { 高麗菜: series } }, rocDate(0));
    expect(items[0].vs_baseline_percent).toBe(-25); // baseline stays 20
  });

  it('stays silent below the minimum-days threshold', () => {
    const { api } = loadBackend();
    const items = [{ name: '高麗菜', avg_price: 15 }] as Record<string, unknown>[];
    api.applyBaselines(
      items,
      { version: 1, items: { 高麗菜: flatSeries(api.BASELINE_MIN_DAYS - 1, 20) } },
      rocDate(0),
    );
    expect(items[0].baseline_price).toBeUndefined();
    expect(items[0].vs_baseline_percent).toBeUndefined();
  });

  it('stays silent when every entry is past the calendar horizon', () => {
    const { api } = loadBackend();
    const stale: [string, number][] = [];
    for (let i = 0; i < 12; i++) stale.push([rocDate(50 + i), 20]);
    const items = [{ name: '高麗菜', avg_price: 15 }] as Record<string, unknown>[];
    api.applyBaselines(items, { version: 1, items: { 高麗菜: stale } }, rocDate(0));
    expect(items[0].baseline_price).toBeUndefined();
  });

  it('reports a positive percent when pricier than usual', () => {
    const { api } = loadBackend();
    const items = [{ name: '高麗菜', avg_price: 25 }] as Record<string, unknown>[];
    api.applyBaselines(items, { version: 1, items: { 高麗菜: flatSeries(12, 20) } }, rocDate(0));
    expect(items[0].vs_baseline_percent).toBe(25);
  });
});

describe('backfillHistory — one-time seeding', () => {
  it('crawls every root per window with range queries, retrying empty roots once', () => {
    const { api, fetches } = loadBackend({
      甘藍: [
        trendRow(rocDate(1), '甘藍-初秋', 20, 60000),
        trendRow(rocDate(1), '甘藍-初秋', 30, 20000, '台中'),
        trendRow(rocDate(2), '甘藍-初秋', 10, 300000),
        trendRow(rocDate(3), '休市', 0, 0), // closed-market placeholder
        trendRow(rocDate(4), '甘藍-初秋', 99, 100), // below MIN_TRADE_VOLUME
      ],
    });
    api.backfillHistory();

    // Only 甘藍 answered, so every other root is retried once per window:
    // N first-pass + (N − 1) retries, for each of the two windows.
    const n = api.boardRoots().length;
    expect(fetches).toHaveLength(2 * (n + (n - 1)));
    expect(fetches[0]).toContain(`Start_time=${rocDate(23)}`);
    expect(fetches[0]).toContain(`End_time=${rocDate(12)}`);
    expect(fetches[fetches.length - 1]).toContain(`Start_time=${rocDate(11)}`);
    expect(fetches[fetches.length - 1]).toContain(`End_time=${rocDate(0)}`);

    // Both windows returned identical rows; per-date merge must not duplicate.
    expect(api.readHistory().items['高麗菜']).toEqual([
      [rocDate(2), 10],
      [rocDate(1), 22.5], // (20×60000 + 30×20000) / 80000
    ]);
  });

  it('keeps shared-root items separated by variety filters', () => {
    const { api } = loadBackend({
      甜椒: [
        trendRow(rocDate(1), '甜椒-青椒', 5, 1000),
        trendRow(rocDate(1), '甜椒-彩色', 50, 1000),
      ],
    });
    api.backfillHistory();
    const items = api.readHistory().items;
    expect(items['青椒']).toEqual([[rocDate(1), 5]]);
    expect(items['甜椒']).toEqual([[rocDate(1), 50]]);
  });
  it('takes the script lock only for the merge, releasing it afterwards', () => {
    const { api, locks } = loadBackend({
      甘藍: [trendRow(rocDate(1), '甘藍-初秋', 20, 60000)],
    });
    api.backfillHistory();
    expect(locks.waits).toBe(1);
    expect(locks.releases).toBe(1);
  });
});

describe('handleBackfill — queueing', () => {
  it('queues one background trigger, locks repeats, force jumps the lock', () => {
    const { api, triggers } = loadBackend();
    expect(api.handleBackfill({}).queued).toBe(true);
    expect(triggers.some((t) => t.handler === 'backfillHistoryOnce')).toBe(true);
    expect(api.handleBackfill({}).queued).toBe(false); // locked
    expect(api.handleBackfill({ force: '1' }).queued).toBe(true);
  });
});
describe('updateHistory — locking', () => {
  it('serialises refresh-path history writes behind the script lock', () => {
    const { api, locks } = loadBackend();
    api.updateHistory({ roc_date: rocDate(1), items: [{ name: '高麗菜', avg_price: 20 }] });
    expect(locks.waits).toBe(1);
    expect(locks.releases).toBe(1);
  });
});

describe('buildBoard — baseline join', () => {
  it('ships baseline fields on built items when history suffices', () => {
    const { api } = loadBackend({ 甘藍: [row('甘藍-初秋', 20, 60000)] });
    const series: [string, number][] = [];
    for (let i = 12; i >= 1; i--) series.push([rocDate(i), 25]);
    api.writeHistory({ version: 1, items: { 高麗菜: series } });

    const board = api.buildBoard();
    const cabbage = board.items.find((it: { name: string }) => it.name === '高麗菜');
    expect(cabbage.baseline_price).toBe(15); // 25 元/公斤 × 0.6
    expect(cabbage.vs_baseline_percent).toBe(-20); // 20 vs 25
  });

  it('surfaces history coverage through diag', () => {
    const { api } = loadBackend();
    api.writeHistory({
      version: 1,
      items: { 高麗菜: [[rocDate(1), 20]], 番茄: [[rocDate(1), 30], [rocDate(2), 31]] },
    });
    expect(api.handleDiag().history).toEqual({ items: 2, min_days: 1, max_days: 2 });
  });
});
describe('varietyBreakdown — per-variety drawer summary', () => {
  const vrow = (CropName: string, Avg_Price: number, Trans_Quantity: number, MarketName = '台北一'): Row =>
    ({ CropName, Avg_Price, Trans_Quantity, MarketName, CropCode: 'V1' });
  const bamboo = { name: '竹筍', official: '竹筍', category: '根莖類' };
  const cabbage = { name: '高麗菜', official: '甘藍', category: '葉菜類' };

  it('publishes qualified varieties by volume with both bases and honest shares', () => {
    const { api } = loadBackend();
    const rows = [
      vrow('竹筍-綠竹筍', 95.2, 9000),
      vrow('竹筍-麻竹筍', 38.7, 13000),
      vrow('竹筍-麻竹筍', 38.7, 0), // invalid row must not distort the group
      vrow('竹筍-烏殼綠', 43.2, 15000),
    ];
    const out = api.varietyBreakdown(bamboo, rows, 37000);
    expect(out.map((v: { name: string }) => v.name)).toEqual(['烏殼綠', '麻竹筍', '綠竹筍']);
    expect(out[0].catty_price).toBe(25.9);
    expect(out[0].share_percent).toBe(41);
    expect(out[2].catty_price).toBe(57.1); // 95.2 × 0.6
  });

  it('estimates each variety with the same markup the card uses', () => {
    const { api } = loadBackend();
    const rows = [vrow('竹筍-綠竹筍', 95.2, 9000), vrow('竹筍-麻竹筍', 38.7, 13000)];
    const out = api.varietyBreakdown(bamboo, rows, 22000);

    // A wholesale-only row cannot be compared with a stall quote, so each row
    // carries the retail estimate too — same table, same rounding as the card.
    for (const v of out) {
      expect(v.retail_price).toBe(api.retailBand(v.catty_price, bamboo.official, bamboo.category).mid);
      expect(v.retail_price).toBeGreaterThan(v.catty_price);
    }
  });

  it("keeps the card's headline the volume-weighted average of the rows", () => {
    const { api } = loadBackend();
    // The markup is additive and constant per crop, so blending wholesale then
    // adding it must equal blending the per-variety retail estimates. That
    // identity is what makes the drawer's explanation true.
    const rows = [vrow('甘藍-改良種', 20, 60000), vrow('甘藍-初秋', 31.5, 20000)];
    const card = api.aggregateGroup(cabbage, rows, []);
    const weighted =
      (card.varieties[0].retail_price * 60000 + card.varieties[1].retail_price * 20000) / 80000;
    expect(Math.abs(card.retail_price - weighted)).toBeLessThanOrEqual(1); // rounding only
  });

  it('returns null for a single variety — the blended number already tells the story', () => {
    const { api } = loadBackend();
    expect(api.varietyBreakdown(cabbage, [vrow('甘藍-初秋', 20, 5000)], 5000)).toBeNull();
  });

  it('folds away sub-10% varieties, and nulls out when folding leaves fewer than two', () => {
    const { api } = loadBackend();
    const rows = [
      vrow('甘藍-初秋', 20, 9500),
      vrow('甘藍-紫色', 90, 400), // 4% share — noise for a shopper
    ];
    expect(api.varietyBreakdown(cabbage, rows, 9900)).toBeNull();

    const three = [
      vrow('甘藍-初秋', 20, 6000),
      vrow('甘藍-改良種', 15, 3500),
      vrow('甘藍-紫色', 90, 500), // 5% — folded, others remain
    ];
    const out = api.varietyBreakdown(cabbage, three, 10000);
    expect(out.map((v: { name: string }) => v.name)).toEqual(['初秋', '改良種']);
    expect(out[0].share_percent + out[1].share_percent).toBeLessThan(100); // folded slice stays visible as a gap
  });

  it('drops varieties below the absolute volume floor even at high share', () => {
    const { api } = loadBackend();
    const rows = [
      vrow('過貓-一號', 100, 150), // 50% share but only 150 kg traded
      vrow('過貓-二號', 80, 150),
    ];
    expect(api.varietyBreakdown({ name: '過貓', official: '蕨菜', category: '葉菜類' }, rows, 300)).toBeNull();
  });

  it('caps the list at four varieties by volume', () => {
    const { api } = loadBackend();
    const rows = ['甲', '乙', '丙', '丁', '戊'].map((v, i) => vrow(`葡萄-${v}`, 50, 3000 + i * 100));
    const out = api.varietyBreakdown({ name: '葡萄', official: '葡萄', category: '水果' }, rows, 15500 + 1000);
    expect(out).toHaveLength(4);
    expect(out[0].name).toBe('戊'); // largest volume first
    expect(out.map((v: { name: string }) => v.name)).not.toContain('甲'); // smallest folded by the cap
  });

  it('labels unmarked rows 一般', () => {
    const { api } = loadBackend();
    const rows = [vrow('香蕉', 30, 5000), vrow('香蕉-芭蕉', 45, 3000)];
    const out = api.varietyBreakdown({ name: '香蕉', official: '香蕉', category: '水果' }, rows, 8000);
    expect(out.map((v: { name: string }) => v.name)).toEqual(['一般', '芭蕉']);
  });

  it('rides on aggregateGroup only when a real breakdown exists', () => {
    const { api } = loadBackend();
    const multi = api.aggregateGroup(bamboo, [
      vrow('竹筍-綠竹筍', 95.2, 9000),
      vrow('竹筍-麻竹筍', 38.7, 13000),
    ], []);
    expect(multi.varieties).toHaveLength(2);

    const single = api.aggregateGroup(bamboo, [vrow('竹筍-麻竹筍', 38.7, 13000)], []);
    expect(single.varieties).toBeUndefined();
  });
});
/**
 * handleSearch was the largest untested behavioural surface: it serves from
 * the cached board when possible and only then falls back to a live MOA
 * query, whose substring matching must be re-grouped by root.
 */
describe('handleSearch', () => {
  const board = () => ({
    type: 'board',
    date: '2026-09-02',
    roc_date: rocDate(0),
    generated_at: new Date().toISOString(),
    count: 1,
    items: [{ name: '高麗菜', official_name: '甘藍', category: '葉菜類', catty_price: 14 }],
  });

  it('serves board hits without any MOA traffic', () => {
    const { api, fetches } = loadBackend();
    api.storeBoard(board());
    const res = api.handleSearch({ query: '高麗' });
    expect(res.type).toBe('search');
    expect(res.items[0].official_name).toBe('甘藍');
    expect(fetches).toHaveLength(0);
  });

  it('falls back to a live query through the alias table on a board miss', () => {
    const { api, fetches } = loadBackend({
      甘藍: [row('甘藍-初秋', 20, 60000)], // feeds both the trade-date probe and the query
    });
    const res = api.handleSearch({ query: 'cabbage' });
    expect(res.type).toBe('search');
    expect(res.items[0].official_name).toBe('甘藍');
    expect(res.items[0].category).toBe('葉菜類');
    expect(fetches.length).toBeGreaterThan(0);
  });

  it('re-groups substring pollution by root and sorts by traded volume', () => {
    const { api } = loadBackend({
      甘藍: [row('甘藍-初秋', 20, 60000)],
      蘿蔔: [
        row('蘿蔔-白', 20, 9000),
        row('胡蘿蔔-清洗', 30, 20000), // MOA substring match — must become its own item
      ],
    });
    const res = api.handleSearch({ query: '蘿蔔' });
    expect(res.items.map((it: { official_name: string }) => it.official_name)).toEqual(['胡蘿蔔', '蘿蔔']);
    expect(res.items[0].trade_volume).toBeGreaterThan(res.items[1].trade_volume);
  });

  it('answers 查無此品項 with a suggestion when nothing trades', () => {
    const { api } = loadBackend({ 甘藍: [row('甘藍-初秋', 20, 60000)] });
    const res = api.handleSearch({ query: '龍鬚菜' });
    expect(res.error).toBe('查無此品項');
    expect(res.suggestion).toBeTruthy();
  });

  it('rejects an empty query without touching anything', () => {
    const { api, fetches } = loadBackend();
    expect(api.handleSearch({}).error).toBe('請輸入查詢關鍵字');
    expect(fetches).toHaveLength(0);
  });
});
/**
 * Alerting is the only part of the pipeline whose failure is invisible: if the
 * mail never arrives, nobody learns the app is stale. These lock down when it
 * fires, when it stays quiet, and — most importantly — that it can never take
 * the board down with it.
 */
describe('failure alerting', () => {
  const goodRows = { 甘藍: [row('甘藍-初秋', 20, 60000)] };

  it('stays quiet while a single refresh failure self-heals', () => {
    const { api, mails, props } = loadBackend(); // no MOA rows → empty board
    api.refreshBoardCache();
    expect(props.get('veggie_alert_streak')).toBe('1');
    expect(mails).toHaveLength(0);
  });

  it('emails once the failures become a streak', () => {
    const { api, mails } = loadBackend();
    for (let i = 0; i < api.ALERT_FAILURE_STREAK; i++) api.refreshBoardCache();

    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(api.ALERT_EMAIL);
    expect(mails[0].subject).toContain('連續 3 次更新失敗');
    expect(mails[0].body).toContain('近期查無交易資料'); // the actual reason, not a generic message
  });

  it('rate-limits to one mail per cooldown window', () => {
    const { api, mails } = loadBackend();
    for (let i = 0; i < api.ALERT_FAILURE_STREAK + 4; i++) api.refreshBoardCache();
    expect(mails).toHaveLength(1);
  });

  it('reports recovery once and resets the streak', () => {
    const { api, mails, props } = loadBackend(goodRows);
    // Force an open incident, then let a good refresh close it.
    props.set('veggie_alert_active', '1');
    props.set('veggie_alert_sent_at', new Date().toISOString());
    props.set('veggie_alert_streak', '5');

    api.refreshBoardCache();

    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain('已恢復正常');
    expect(props.get('veggie_alert_streak')).toBe('0');
    expect(props.has('veggie_alert_active')).toBe(false);

    // A second healthy refresh must not re-announce recovery.
    api.refreshBoardCache();
    expect(mails).toHaveLength(1);
  });

  it('says nothing on a healthy refresh with no incident open', () => {
    const { api, mails } = loadBackend(goodRows);
    api.refreshBoardCache();
    expect(mails).toHaveLength(0);
  });

  it('never lets a mail failure break the refresh', () => {
    const { api, breakMail, logs } = loadBackend();
    breakMail();
    for (let i = 0; i < api.ALERT_FAILURE_STREAK; i++) {
      expect(() => api.refreshBoardCache()).not.toThrow();
    }
    expect(logs.some((l) => l.includes('alert bookkeeping failed'))).toBe(true);
  });

  it('never lets a mail failure break board serving', () => {
    const { api, breakMail } = loadBackend();
    breakMail();
    api.storeBoard({
      type: 'board', date: '2026-08-26', roc_date: '115.08.26', count: 1,
      items: [{ code: 'C1', name: '高麗菜' }],
      generated_at: new Date(Date.now() - api.ALERT_SILENCE_MS - 60_000).toISOString(),
    });
    const board = api.readBoard();
    expect(board.items).toHaveLength(1); // prices still served
  });

  describe('silence detection on the serving path', () => {
    const boardAged = (ms: number) => ({
      type: 'board', date: '2026-08-26', roc_date: '115.08.26', count: 1,
      items: [{ code: 'C1', name: '高麗菜' }],
      generated_at: new Date(Date.now() - ms).toISOString(),
    });

    it('emails when the board keeps ageing with no failures to count', () => {
      const { api, mails } = loadBackend();
      api.storeBoard(boardAged(api.ALERT_SILENCE_MS + 60_000));
      api.readBoard();
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toContain('看板已停止更新');
      expect(mails[0].body).toContain('installDailyTrigger'); // tells the reader how to fix it
    });

    it('stays quiet for a merely stale board that self-heal already covers', () => {
      const { api, mails } = loadBackend();
      api.storeBoard(boardAged(api.BOARD_MAX_AGE_MS + 60_000));
      const board = api.readBoard();
      expect(board.stale).toBe(true);
      expect(board.refresh_queued).toBe(true);
      expect(mails).toHaveLength(0); // a queued rebuild is not an incident
    });

    it('emails at most once per cooldown however many visitors arrive', () => {
      const { api, mails } = loadBackend();
      api.storeBoard(boardAged(api.ALERT_SILENCE_MS + 60_000));
      api.readBoard();
      api.readBoard();
      api.readBoard();
      expect(mails).toHaveLength(1);
    });
  });

  it('exposes alert state through diag without leaking the address', () => {
    const { api } = loadBackend();
    api.refreshBoardCache();
    const diag = api.handleDiag();
    expect(diag.alert).toEqual({ failure_streak: 1, incident_open: false, last_sent: null });
    expect(JSON.stringify(diag)).not.toContain(api.ALERT_EMAIL);
  });

  describe('?action=alerttest', () => {
    it('sends one probe mail and then locks, leaving incident state untouched', () => {
      const { api, mails, props } = loadBackend();
      const first = api.handleAlertTest();
      expect(first.sent).toBe(true);
      expect(mails[0].subject).toContain('測試信');

      const second = api.handleAlertTest();
      expect(second.sent).toBe(false);
      expect(mails).toHaveLength(1);
      // A test must never look like, or suppress, a real incident.
      expect(props.has('veggie_alert_active')).toBe(false);
      expect(props.has('veggie_alert_sent_at')).toBe(false);
    });

    it('reports a failure CATEGORY without echoing the raw exception', () => {
      const { api, breakMail, props } = loadBackend();
      breakMail();
      const failed = api.handleAlertTest();

      expect(failed.sent).toBe(false);
      // Category is what the operator acts on: an unauthorised scope reads
      // differently from an exhausted quota.
      expect(failed.reason).toBe('mail_quota_exhausted');
      // The endpoint is public and unauthenticated, and Apps Script mail
      // errors can quote the recipient address — raw text must never leak.
      expect(JSON.stringify(failed)).not.toContain('mail quota exceeded');
      expect(JSON.stringify(failed)).not.toContain(api.ALERT_EMAIL);
      // ...but the raw text is kept for whoever owns the script.
      expect(props.has('veggie_alert_test_failed_at')).toBe(true);
    });

    it('backs off after a failure so a broken channel cannot be hammered', () => {
      const { api, breakMail, fixMail, mails } = loadBackend();
      breakMail();
      expect(api.handleAlertTest().reason).toBe('mail_quota_exhausted');

      // A failed probe consumes no mail quota, so without a backoff a loop of
      // them would keep seizing the shared lock and starve the real alerts.
      fixMail();
      const blocked = api.handleAlertTest();
      expect(blocked.sent).toBe(false);
      expect(blocked.message).toContain('剛才寄送失敗');
      expect(mails).toHaveLength(0);
    });

    it('sends again once the backoff has aged out, and clears it', () => {
      const { api, breakMail, fixMail, props, mails } = loadBackend();
      breakMail();
      api.handleAlertTest();
      fixMail();
      // Age the backoff past its window.
      props.set('veggie_alert_test_failed_at', new Date(Date.now() - 5 * 60_000).toISOString());

      expect(api.handleAlertTest().sent).toBe(true);
      expect(mails).toHaveLength(1);
      expect(props.has('veggie_alert_test_failed_at')).toBe(false);
    });
  });
});

/**
 * The staleness threshold answers "is the pipeline dead?", so it must sit
 * above the refresh cadence plus a crawl. When both were 4 h, a healthy board
 * reported itself stale in the minutes before every scheduled run.
 */
describe('refresh cadence vs staleness threshold', () => {
  it('leaves at least an hour of headroom above the cadence', () => {
    const { api } = loadBackend();
    const cadenceMs = api.REFRESH_INTERVAL_HOURS * 60 * 60 * 1000;
    expect(api.BOARD_MAX_AGE_MS).toBeGreaterThanOrEqual(cadenceMs + 60 * 60 * 1000);
  });

  it('installs the cron from the same constant the threshold is derived from', () => {
    const { api, triggers } = loadBackend({ 甘藍: [row('甘藍-初秋', 20, 60000)] });
    api.installDailyTrigger();
    expect(triggers).toEqual([
      { handler: 'refreshBoardCache', kind: `everyHours:${api.REFRESH_INTERVAL_HOURS}` },
    ]);
  });

  it('alerts on silence only well after self-heal has had its chance', () => {
    const { api } = loadBackend();
    expect(api.ALERT_SILENCE_MS).toBeGreaterThan(api.BOARD_MAX_AGE_MS);
  });
});
/**
 * Concurrency and failure regressions from review. Every alert decision is a
 * read-modify-write on shared state, and Apps Script allows 30 simultaneous
 * executions against a ~100 mail/day quota — so "one incident, one mail" has
 * to survive a burst, and no alerting failure may reach the board.
 */
describe('alerting under contention and failure', () => {
  const goodRows = { 甘藍: [row('甘藍-初秋', 20, 60000)] };

  it('takes and releases the lock for every decision', () => {
    const { api, locks } = loadBackend();
    api.refreshBoardCache();
    expect(locks.tries).toBe(1);
    expect(locks.releases).toBeGreaterThanOrEqual(1);
  });

  it('skips the decision entirely when another execution owns the lock', () => {
    const { api, contendLock, mails, props } = loadBackend();
    contendLock();
    for (let i = 0; i < api.ALERT_FAILURE_STREAK + 2; i++) {
      expect(() => api.refreshBoardCache()).not.toThrow();
    }
    expect(mails).toHaveLength(0);
    // Nothing was written either, so an uncontended run still counts cleanly.
    expect(props.has('veggie_alert_streak')).toBe(false);
  });

  it('keeps the silence alert to one mail across a burst of visitors', () => {
    const { api, mails } = loadBackend();
    api.storeBoard({
      type: 'board', date: '2026-08-26', roc_date: '115.08.26', count: 1,
      items: [{ code: 'C1', name: '高麗菜' }],
      generated_at: new Date(Date.now() - api.ALERT_SILENCE_MS - 60_000).toISOString(),
    });
    for (let i = 0; i < 30; i++) api.readBoard();
    expect(mails).toHaveLength(1);
  });

  it('leaves the incident open when the recovery mail fails, and retries later', () => {
    const { api, props, mails, breakMail, fixMail } = loadBackend(goodRows);
    props.set('veggie_alert_active', '1');
    props.set('veggie_alert_sent_at', new Date().toISOString());

    breakMail();
    api.refreshBoardCache();
    expect(mails).toHaveLength(0);
    // Clearing state before a successful send would strand the reader on a
    // stale "still broken" impression forever.
    expect(props.get('veggie_alert_active')).toBe('1');

    fixMail();
    api.refreshBoardCache();
    expect(mails.map((m) => m.subject)).toEqual(['[VeggieRadar] 已恢復正常']);
    expect(props.has('veggie_alert_active')).toBe(false);
  });

  it('never lets alert bookkeeping failure break a healthy refresh', () => {
    const { api, breakProp, logs } = loadBackend(goodRows);
    breakProp('veggie_alert_streak');
    const board = api.refreshBoardCache();
    expect(board.count).toBeGreaterThan(0); // the board still shipped
    expect(logs.some((l) => l.includes('alert bookkeeping failed'))).toBe(true);
  });

  it('keeps the probe limiter durable across cache eviction', () => {
    const { api, cache, mails } = loadBackend();
    expect(api.handleAlertTest().sent).toBe(true);
    cache.clear(); // CacheService entries can vanish at any time
    const second = api.handleAlertTest();
    expect(second.sent).toBe(false);
    expect(second.message).toContain('一小時內');
    expect(mails).toHaveLength(1);
  });

  it('reports contention rather than sending when the probe loses the lock', () => {
    const { api, contendLock, mails } = loadBackend();
    contendLock();
    const res = api.handleAlertTest();
    expect(res.sent).toBe(false);
    expect(res.message).toContain('另一個執行');
    expect(res.error).toBeUndefined(); // contention is not a channel failure
    expect(mails).toHaveLength(0);
  });
});
/**
 * The backend is split across several .gs files that Apps Script merges into
 * one global scope. These are the two properties that keep that split safe
 * forever, as opposed to the one-off "nothing was dropped" check that belonged
 * to the migration itself and would rot into a test of a deleted file.
 */
describe('backend file layout', () => {
  it('declares every global exactly once across the merged scope', () => {
    // Catches the copy-paste that leaves a function in two files, where Apps
    // Script would silently keep whichever loads last.
    const declarations = [...SOURCE.matchAll(/^(?:function (\w+)|var (\w+))/gm)].map((m) => m[1] ?? m[2]);
    const duplicated = declarations.filter((n, i) => declarations.indexOf(n) !== i);
    expect(duplicated).toEqual([]);
    expect(declarations).toContain('doGet');
    expect(declarations).toContain('BOARD_ITEMS');
  });

  it('keeps load order irrelevant: no top-level initialiser touches another file', () => {
    // This is what lets the project ship without a pinned file order. A `var`
    // initialised from a function call or from another constant would make the
    // load sequence load-bearing — and Apps Script's order is not something
    // this repo controls.
    const names = new Set(
      [...SOURCE.matchAll(/^(?:function (\w+)|var (\w+))/gm)].map((m) => m[1] ?? m[2]),
    );
    const offenders: string[] = [];
    for (const file of GS_FILES) {
      const lines = readFileSync(resolve(BACKEND_DIR, file), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const decl = lines[i].match(/^var (\w+) = (.*)$/);
        if (!decl) continue;
        let init = decl[2];
        while (i < lines.length - 1 && !/;\s*(\/\/.*)?$/.test(lines[i])) init += '\n' + lines[++i];
        const code = init.replace(/\/\/.*$/gm, '').replace(/'[^']*'/g, "''");
        const calls = [...code.matchAll(/(\w+)\s*\(/g)].map((m) => m[1]);
        const refs = [...code.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)]
          .map((m) => m[1])
          .filter((n) => names.has(n));
        if (calls.length || refs.length) offenders.push(`${file}:${decl[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
