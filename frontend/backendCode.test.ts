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
import { BOARD_MIN_ITEMS, BOARD_HEALTHY_ITEMS, BoardResponseSchema } from './src/types/board.schema';

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
function loadBackend(responses: Record<string, Row[]> = {}, overrides: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const props = new Map<string, string>();
  const cache = new Map<string, string>();
  const triggers: { handler: string; kind: string }[] = [];
  /** A unique id per created trigger, kept off the objects tests compare. */
  const triggerIds = new WeakMap<object, string>();
  let triggerSeq = 0;
  const uidOf = (t: { handler: string; kind: string }) => triggerIds.get(t) ?? `${t.handler}:${t.kind}`;
  /** The TTL each cache key was last put with. */
  const cacheTtls = new Map<string, number | undefined>();
  const fetches: string[] = [];
  /** POSTs to GitHub's `/dispatches`, with their options — see `requestMirrorDeploy`. */
  const dispatches: { url: string; options: Record<string, unknown> }[] = [];
  let dispatchStatus = 204;
  let dispatchThrows = false;
  const locks = { waits: 0, tries: 0, releases: 0, contended: false };
  /** The long-term history spreadsheet (#22), in memory: a grid, not a list. */
  type Tab = { rows: unknown[][]; maxRows: number; textColumnA: boolean; frozen?: number };
  const tabs = new Map<string, Tab>();
  const openedIds: string[] = [];
  const cacheRemovals: { key: string; triggers: string[] }[] = [];
  const formatZones: string[] = [];
  /** Every `getValues` on a tab, by tab name: what a job costs in reads. */
  const sheetReads: string[] = [];
  /** Cells read, all tabs: what a read costs, not just how many there were. */
  const cellsRead = { count: 0 };
  const freezes: string[] = [];
  /** Called after every `getValues`: lets a test change a tab between two reads. */
  const afterRead = { hook: (_tab: string) => {} };
  let brokenReadKey: string | null = null;
  /** Tabs whose next `setValues` throws, once — a write that fails part-way. */
  const failingWrites = new Set<string>();
  let sheetThrows = false;
  let sheetZone = 'Asia/Taipei';
  let triggerDeleteThrows = false;
  const mails: { to: string; subject: string; body: string }[] = [];
  let mailThrows = false;
  let brokenPropKey: string | null = null;

  const respond = (url: string, options?: Record<string, unknown>) => {
    fetches.push(url);
    if (url.indexOf('api.github.com') !== -1) {
      // UrlFetchApp throws on DNS and TLS failures whatever `muteHttpExceptions`
      // says, so a broken dispatch has to be reachable both ways.
      if (dispatchThrows) throw new Error('DNS error: api.github.com');
      dispatches.push({ url, options: options ?? {} });
      return { getResponseCode: () => dispatchStatus, getContentText: () => '' };
    }
    const hit = Object.keys(responses).find((key) => url.includes(encodeURIComponent(key)));
    const rows = hit ? responses[hit] : [];
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ RS: 'OK', Data: rows }),
    };
  };

  /** The slice of the Sheets API `SheetHistory.gs` uses, and nothing more. */
  const tabApi = (name: string) => {
    const tab = () => tabs.get(name) as Tab;
    const rows = () => tab().rows;
    return {
      getName: () => name,
      getLastRow: () => rows().length,
      // A real tab is a fixed grid: `setValues` past `getMaxRows()` throws
      // rather than growing it, which is what killed the first version of the
      // archive in review — a default 1000-row tab fills in about five days.
      getMaxRows: () => tab().maxRows,
      insertRowsAfter: (after: number, howMany: number) => {
        tab().maxRows = Math.max(tab().maxRows, after) + howMany;
      },
      getRange: (row: number, col: number, numRows: number, numCols: number) => ({
        setValues: (values: unknown[][]) => {
          if (failingWrites.delete(name)) throw new Error('Service Spreadsheets timed out');
          if (row + values.length - 1 > tab().maxRows) {
            throw new Error('The coordinates or dimensions of the range are invalid.');
          }
          values.forEach((v, i) => {
            // …and a date-looking string lands in a date cell unless the
            // column says otherwise, coming back as a Date.
            rows()[row - 1 + i] = v.map((cell, j) =>
              j === 0 && tab().textColumnA === false && typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cell)
                ? new Date(`${cell}T00:00:00`)
                : cell);
          });
        },
        getValues: () => {
          sheetReads.push(name);
          cellsRead.count += numRows * numCols;
          const out = rows().slice(row - 1, row - 1 + numRows).map((r) => (r ?? []).slice(col - 1, col - 1 + numCols));
          afterRead.hook(name);
          return out;
        },
        setNumberFormat: (format: string) => {
          if (col === 1 && format === '@') tab().textColumnA = true;
        },
      }),
      deleteRows: (start: number, count: number) => void rows().splice(start - 1, count),
      setFrozenRows: (n: number) => {
        freezes.push(name);
        tab().frozen = n;
      },
    };
  };

  const services = {
    SpreadsheetApp: {
      openById: (id: string) => {
        if (sheetThrows) throw new Error('Requested entity was not found');
        openedIds.push(id);
        return {
          // The spreadsheet's own zone, which is what a date cell means —
          // not the script's.
          getSpreadsheetTimeZone: () => sheetZone,
          getSheetByName: (name: string) => (tabs.has(name) ? tabApi(name) : null),
          getSheets: () => [...tabs.keys()].map((name) => tabApi(name)),
          insertSheet: (name: string) => {
            // Sheets' own default for a new tab, which is the whole point of
            // `growFor`.
            tabs.set(name, { rows: [], maxRows: 1000, textColumnA: false });
            return tabApi(name);
          },
        };
      },
    },
    UrlFetchApp: {
      fetch: (url: string, options?: Record<string, unknown>) => respond(url, options),
      fetchAll: (reqs: { url: string }[]) => reqs.map((r) => respond(r.url)),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k: string) => cache.get(k) ?? null,
        put: (k: string, v: string, ttl?: number) => {
          cacheTtls.set(k, ttl);
          cache.set(k, v);
        },
        remove: (k: string) => {
          // What the trigger list looked like at that moment, so a test can
          // pin the ORDER of a cleanup rather than only its outcome.
          cacheRemovals.push({ key: k, triggers: triggers.map((t) => t.handler) });
          cache.delete(k);
        },
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => {
          if (k === brokenReadKey) throw new Error('properties service unavailable');
          return props.get(k) ?? null;
        },
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
        waitLock: (_ms: number) => {
          locks.waits += 1;
          // The real one throws when it cannot acquire inside the timeout,
          // which is what every `withHistoryLock` caller has to survive.
          if (locks.contended) throw new Error('Could not obtain lock');
        },
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
    Utilities: {
      sleep: () => {},
      // Only the one pattern `SheetHistory.gs` asks for, and it records the
      // zone so a test can assert which one was used.
      formatDate: (date: Date, zone: string, pattern: string) => {
        formatZones.push(zone);
        if (pattern !== 'yyyy-MM-dd') throw new Error(`unstubbed pattern ${pattern}`);
        const shifted = zone === 'Pacific/Auckland' ? new Date(date.getTime() + 4 * 3_600_000) : date;
        return [
          shifted.getFullYear(),
          String(shifted.getMonth() + 1).padStart(2, '0'),
          String(shifted.getDate()).padStart(2, '0'),
        ].join('-');
      },
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t: string) => ({ setMimeType: () => ({ body: t }) }),
    },
    ScriptApp: {
      getProjectTriggers: () =>
        triggers.map((t) => ({
          getHandlerFunction: () => t.handler,
          getUniqueId: () => uidOf(t),
        })),
      deleteTrigger: (t: { getHandlerFunction: () => string; getUniqueId: () => string }) => {
        if (triggerDeleteThrows) throw new Error('Service unavailable: Script service');
        const i = triggers.findIndex((x) => uidOf(x) === t.getUniqueId());
        if (i >= 0) triggers.splice(i, 1);
      },
      newTrigger: (handler: string) => {
        const spec = { handler, kind: 'unset' };
        const clock = {
          after: (ms: number) => ((spec.kind = `after:${ms}`), clock),
          everyHours: (h: number) => ((spec.kind = `everyHours:${h}`), clock),
          create: () => {
            triggerIds.set(spec, `t${++triggerSeq}`);
            triggers.push(spec);
          },
        };
        return { timeBased: () => clock };
      },
    },
  };

  const exported = [
    'tradedRows', 'selectRows', 'rowRoot', 'rowVariety', 'isTradingDate',
    'retailBand', 'aggregateGroup', 'boardRoots', 'BOARD_ITEMS',
    'RETAIL_MARKUP_ROOT', 'RETAIL_MARKUP_CATEGORY', 'storeBoard', 'readDurableBoard',
    'readBoard', 'boardAgeMs', 'scheduleRefresh', 'refreshBoardCacheOnce', 'dropTriggers', 'handleWarm',
    'handleDiag', 'BOARD_MAX_AGE_MS', 'REFRESH_ONCE_FN',
    'handleTrend', 'resolveTradeDates',
    'median', 'appendObservation', 'updateHistory', 'readHistory', 'writeHistory',
    'applyBaselines', 'backfillHistory', 'backfillHistoryOnce', 'mergeCrawled', 'handleBackfill', 'buildBoard',
    'BASELINE_WINDOW', 'BASELINE_MIN_DAYS', 'varietyBreakdown', 'handleSearch', 'RETAIL_BAND_ROOT',
    'sendAlert', 'recordRefreshOutcome', 'withAlertLock', 'handleAlertTest',
    'ALERT_FAILURE_STREAK', 'ALERT_SILENCE_MS', 'ALERT_COOLDOWN_MS',
    'REFRESH_INTERVAL_HOURS', 'installDailyTrigger', 'refreshBoardCache',
    'doGet', 'isAdmin', 'alertRecipient', 'redactFailure', 'ADMIN_TOKEN_PROP', 'ALERT_EMAIL_PROP',
    'requestMirrorDeploy', 'GH_DISPATCH_TOKEN_PROP', 'GH_DISPATCH_EVENT', 'GH_DISPATCH_URL',
    'appendDailyHistory', 'historyRowsFor', 'SHEET_HEADER', 'HISTORY_SHEET_ID_PROP',
    'SHEET_LAST_WRITE_PROP', 'SHEET_CORRECTION_MS',
    'handleSheetBackfill', 'sheetBackfillStep', 'backfillDays', 'fetchCompleteRows', 'archiveSummary',
    'SHEET_BACKFILL_PROP', 'SHEET_BACKFILL_FN', 'SHEET_BACKFILL_MAX_FAILURES', 'SHEET_BACKFILL_STALL_MS',
    'refreshYearAgo', 'keptYearAgo', 'applyYearOverYear', 'YOY_PROP', 'YOY_EMPTY_RETRY_MS', 'YOY_KEEP_MS',
    'GH_DISPATCH_MIN_INTERVAL_MS', 'GH_DISPATCH_FAIL_BACKOFF_MS', 'GH_DISPATCH_PROP', 'GH_DISPATCH_OK_PROP',
    'validateBoard', 'markSuspects', 'readChunkedProp',
    'BOARD_MIN_ITEMS', 'REJECTED_PROP_PREFIX', 'REJECTED_PROP_COUNT',
    'normalizeQuery', 'searchTerms', 'catalogRoots', 'withinOneEdit', 'CROP_CATALOG', 'SEARCH_ALIASES',
    'catalogUsable', 'CROP_CATALOG_CRAWLED_AT', 'CATALOG_MAX_AGE_DAYS', 'defsForRoot',
    'SEARCH_MAX_ROOTS', 'SEARCH_MAX_SUGGESTIONS', 'SEARCH_CACHE_PREFIX',
  ];
  const merged: Record<string, unknown> = { ...services, ...overrides };
  const factory = new Function(
    ...Object.keys(merged),
    `${SOURCE}\nreturn { ${exported.join(', ')} };`,
  );
  const api = factory(...Object.values(merged));
  // The recipient is configuration, not code: seed it the way an operator
  // would, so the alert suites exercise the send path. Suites that need an
  // unconfigured recipient delete it.
  props.set('ALERT_EMAIL', 'owner@example.com');
  return {
    api,
    logs, props, cache, triggers, fetches, locks, mails, dispatches, tabs, openedIds,
    breakSheet: () => { sheetThrows = true; },
    formatZones, cacheRemovals, sheetReads,
    failWriteOnce: (tab: string) => { failingWrites.add(tab); },
    cellsRead, cacheTtls, freezes, afterRead,
    /** The id `ScriptApp` would pass a trigger's handler as `e.triggerUid`. */
    uidOf,
    breakRead: (key: string) => { brokenReadKey = key; },
    setSheetZone: (zone: string) => { sheetZone = zone; },
    breakTriggerDelete: () => { triggerDeleteThrows = true; },
    breakDispatch: () => { dispatchThrows = true; },
    rejectDispatch: (code: number) => { dispatchStatus = code; },
    breakMail: () => { mailThrows = true; },
    fixMail: () => { mailThrows = false; },
    breakProp: (key: string) => { brokenPropKey = key; },
    contendLock: () => { locks.contended = true; },
    /** Parsed JSON body of a `doGet` call — the shape a browser would see. */
    get: (parameter: Record<string, string>) => JSON.parse(factoryOut(parameter).body),
  };

  function factoryOut(parameter: Record<string, string>): { body: string } {
    return api.doGet({ parameter });
  }
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

  it('only publishes a per-crop band strictly tighter than the fallback it replaces', () => {
    // Equal width would be no more informative than the category default, so
    // the rule is `<`, not `<=` — that is what excludes 豌豆 and 洋香瓜, whose
    // fitted spread came out exactly as wide as their category band.
    for (const [root, band] of Object.entries(api.RETAIL_BAND_ROOT) as [string, number[]][]) {
      const def = api.BOARD_ITEMS.find((d: { official: string }) => d.official === root);
      expect(def, `${root} must be a board crop`).toBeDefined();
      const cat = api.RETAIL_MARKUP_CATEGORY[def.category];
      expect(band[2] - band[0], `${root} band not tighter than ${def.category}`).toBeLessThan(cat[2] - cat[0]);
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

/**
 * A `Date` the backend sees as a later day, for the one behaviour that is
 * defined by the passage of months: the crop catalogue ageing out of the
 * search gate. Injected as a parameter, which shadows the global inside the
 * merged scope — the source never declares `Date` itself.
 */
const expiredClock = (at: number) =>
  class FrozenDate extends Date {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length === 0) super(at);
      else super(...args);
    }
    static now() {
      return at;
    }
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

describe('backfillHistory — losing the lock', () => {
  it('retries the merge, and frees the queue when it still cannot write', () => {
    // The archive now holds this lock across a Sheets round trip, so a 30 s
    // wait can genuinely time out — and a thrown timeout would throw away a
    // crawl that took minutes, behind an hour-long queue lock that stops
    // anyone asking again.
    const { api, cache, contendLock, locks, logs } = loadBackend(plausibleRows());
    api.handleBackfill({});
    expect(cache.get('veggie_backfill_queued')).toBe('1');
    contendLock();

    const result = api.backfillHistoryOnce();

    expect(result.merged).toBe(false);
    expect(locks.waits).toBe(2); // tried twice before giving the crawl up
    expect(logs.some((l) => l.includes('history lock busy'))).toBe(true);
    expect(logs.some((l) => l.includes('merged nothing (busy)'))).toBe(true);
    expect(cache.has('veggie_backfill_queued')).toBe(false); // ask again whenever you like
  });

  it('tells a busy lock apart from a merge that threw', () => {
    // Only the first is worth retrying: a lock someone else holds clears on
    // its own, and a merge that threw would throw again the same way. They
    // are told apart by whether the body ran at all.
    const { api, locks, logs } = loadBackend();
    expect(api.mergeCrawled([null])).toBe('failed'); // the body, not the lock
    expect(locks.waits).toBe(1);
    expect(logs.some((l) => l.includes('mergeCrawled failed'))).toBe(true);
    expect(logs.some((l) => l.includes('history lock busy'))).toBe(false);
  });

  it('frees the queue even when the trigger will not drop', () => {
    // Both cleanups are guarded, and the trigger goes first: freeing the lock
    // before the trigger is gone leaves a window where a new backfill queues
    // itself and has its trigger deleted by this very line.
    const { api, cache, contendLock, breakTriggerDelete, logs } = loadBackend(plausibleRows());
    api.handleBackfill({});
    contendLock();
    breakTriggerDelete();

    expect(() => api.backfillHistoryOnce()).not.toThrow();
    expect(cache.has('veggie_backfill_queued')).toBe(false);
    expect(logs.some((l) => l.includes('trigger not dropped'))).toBe(true);
  });

  it('drops the trigger before it frees the lock, not after', () => {
    // The order is the point, not just the outcome. Freeing the lock first
    // leaves a window where a `handleBackfill` re-locks and installs a fresh
    // trigger that this `finally` then deletes: it reports "queued", nothing
    // runs, and plain retries are refused for the rest of the hour. With the
    // trigger dropped first, the worst interleaving leaves the lock still
    // held, and the next request simply declines to queue.
    const { api, cacheRemovals, contendLock } = loadBackend(plausibleRows());
    api.handleBackfill({});
    contendLock(); // so the merge fails and the lock is freed

    api.backfillHistoryOnce();

    const freed = cacheRemovals.find((r) => r.key === 'veggie_backfill_queued');
    expect(freed).toBeDefined();
    expect(freed?.triggers).not.toContain('backfillHistoryOnce');
  });

  it('keeps the queue lock when the merge worked', () => {
    const { api, cache } = loadBackend(plausibleRows());
    api.handleBackfill({});
    expect(api.backfillHistoryOnce().merged).toBe(true);
    expect(cache.get('veggie_backfill_queued')).toBe('1'); // one queued backfill per hour
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

  /**
   * The frontend↔backend contract, checked against the real `buildBoard()`
   * output rather than a fixture of what it is believed to return. Both sides
   * of the wire live in this repo and only this assertion connects them: a
   * renamed or re-typed field on the Apps Script side is valid JSON that
   * reaches the UI as `undefined`, which is a silent, shipped bug. Zod's
   * issues are asserted (not just `success`) so a failure names the field.
   */
  it('emits a payload the frontend board schema accepts', () => {
    const { api } = loadBackend({ 甘藍: [row('甘藍-初秋', 20, 60000)] });
    const series: [string, number][] = [];
    for (let i = 12; i >= 1; i--) series.push([rocDate(i), 25]);
    api.writeHistory({ version: 1, items: { 高麗菜: series } });

    const result = BoardResponseSchema.safeParse(api.buildBoard());
    expect(result.success ? [] : result.error.issues).toEqual([]);
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
  // A "good refresh" now has to clear the plausibility floor: `refreshBoardCache`
  // no longer stores a one-item board. See `plausibleRows` at the end of the file.
  const goodRows = plausibleRows();

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
    expect(mails[0].to).toBe('owner@example.com'); // the seeded ALERT_EMAIL property
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

  it('never lets a mail failure break the refresh, and still opens the incident', () => {
    const { api, breakMail, props, logs } = loadBackend();
    breakMail();
    for (let i = 0; i < api.ALERT_FAILURE_STREAK; i++) {
      expect(() => api.refreshBoardCache()).not.toThrow();
    }
    // The backend knows it is broken whether or not it could say so, and the
    // category says which half failed (#65).
    expect(props.get('veggie_alert_active')).toBe('1');
    expect(props.get('veggie_alert_unsent_reason')).toBe('mail_quota_exhausted');
    expect(logs.some((l) => l.includes('alert mail failure'))).toBe(true);
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

  describe('an incident opens even when nobody can be told (#65)', () => {
    // The external probe watches this project from outside by reading
    // `diag.alert.incident_open`. While that depended on a mail going out, a
    // deployment with no ALERT_EMAIL reported health for a pipeline that had
    // already given up.

    it('opens the incident and arms the cooldown with no recipient configured', () => {
      const { api, props, mails } = loadBackend();
      props.delete(api.ALERT_EMAIL_PROP);

      for (let i = 0; i < api.ALERT_FAILURE_STREAK; i++) api.refreshBoardCache();

      expect(mails).toHaveLength(0); // there is nowhere to send it
      expect(props.get('veggie_alert_active')).toBe('1');
      expect(api.handleDiag().alert).toMatchObject({
        incident_open: true,
        recipient_configured: false,
        last_send_failure: 'no_recipient',
      });
    });

    it('does not re-attempt a send for every later failure inside the cooldown', () => {
      const { api, props, logs } = loadBackend();
      props.delete(api.ALERT_EMAIL_PROP);
      for (let i = 0; i < api.ALERT_FAILURE_STREAK + 4; i++) api.refreshBoardCache();

      // One attempt, not one per failure: the cooldown arms on the incident,
      // which is exactly what could not happen while the send threw.
      expect(logs.filter((l) => l.includes('no alert recipient'))).toHaveLength(1);
    });

    it('opens it on the serving path too, and then holds its tongue', () => {
      const { api, props, mails, logs } = loadBackend();
      props.delete(api.ALERT_EMAIL_PROP);
      api.storeBoard({
        type: 'board', date: '2026-08-26', roc_date: '115.08.26', count: 1,
        items: [{ code: 'C1', name: '高麗菜' }],
        generated_at: new Date(Date.now() - api.ALERT_SILENCE_MS - 60_000).toISOString(),
      });

      expect(api.readBoard().items).toHaveLength(1); // prices still served
      expect(props.get('veggie_alert_active')).toBe('1');
      expect(props.get('veggie_alert_unsent_reason')).toBe('no_recipient');
      expect(mails).toHaveLength(0);

      // A burst of visitors attempts the send once, because the cooldown now
      // arms — which is what could not happen while the send threw.
      for (let i = 0; i < 5; i++) api.readBoard();
      expect(logs.filter((l) => l.includes('no alert recipient'))).toHaveLength(1);
    });

    it('closes it again on recovery, since no retry can ever deliver', () => {
      const { api, props } = loadBackend(plausibleRows());
      props.delete(api.ALERT_EMAIL_PROP);
      props.set('veggie_alert_active', '1');
      props.set('veggie_alert_sent_at', new Date().toISOString());

      api.refreshBoardCache();

      // Holding it open to retry an all-clear that can never be sent would
      // page the probe forever for a backend that recovered.
      expect(props.has('veggie_alert_active')).toBe(false);
      expect(api.handleDiag().alert.incident_open).toBe(false);
    });

    it('takes the silence category away with the incident', () => {
      const { api, props } = loadBackend(plausibleRows());
      props.delete(api.ALERT_EMAIL_PROP);
      props.set('veggie_alert_active', '1');
      props.set('veggie_alert_sent_at', new Date().toISOString());
      props.set('veggie_alert_unsent_reason', 'no_recipient');

      api.refreshBoardCache();

      // The category explains one incident's mail. Left behind, it would
      // describe a silent mailbox in `diag` long after the operator had
      // configured one.
      expect(props.has('veggie_alert_unsent_reason')).toBe(false);
      expect(api.handleDiag().alert.last_send_failure).toBeNull();
    });

    it('clears a category left behind by the build this replaces', () => {
      // The deployed backend can close an incident without touching the
      // category, because it has no category to touch. This is the branch
      // that repairs that state on the first healthy refresh after the
      // deploy; nothing the new code writes can reach it.
      const { api, props } = loadBackend(plausibleRows());
      props.set('veggie_alert_unsent_reason', 'mail_quota_exhausted');

      api.refreshBoardCache();

      expect(props.has('veggie_alert_unsent_reason')).toBe(false);
      expect(api.handleDiag().alert.last_send_failure).toBeNull();
    });

    it('keeps the flag when the store can no longer take the timestamp', () => {
      // A rejected board writes its chunks into the same properties store, so
      // a full store is the state this whole issue is about. Whichever of
      // `openIncident`'s two writes runs second is the one that is lost, and
      // the flag is the one the external probe reads.
      const { api, props, breakProp } = loadBackend();
      breakProp('veggie_alert_sent_at');

      for (let i = 0; i < api.ALERT_FAILURE_STREAK; i++) api.refreshBoardCache();

      expect(props.get('veggie_alert_active')).toBe('1');
      expect(api.handleDiag().alert.incident_open).toBe(true);
    });

    it('leaves the send path untouched when a recipient is configured', () => {
      const { api, props, mails } = loadBackend();
      for (let i = 0; i < api.ALERT_FAILURE_STREAK; i++) api.refreshBoardCache();

      expect(mails).toHaveLength(1);
      expect(mails[0].to).toBe('owner@example.com');
      expect(props.get('veggie_alert_active')).toBe('1');
      expect(props.has('veggie_alert_unsent_reason')).toBe(false);
    });
  });

  it('exposes alert state through diag without leaking the address', () => {
    const { api } = loadBackend();
    api.refreshBoardCache();
    const diag = api.handleDiag();
    expect(diag.alert).toEqual({
      failure_streak: 1, incident_open: false, last_attempt: null, recipient_configured: true, last_send_failure: null,
    });
    expect(JSON.stringify(diag)).not.toContain('owner@example.com');
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
      expect(JSON.stringify(failed)).not.toContain('owner@example.com');
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
/**
 * The mirror deploy dispatch (#68).
 *
 * The published mirror is only as fresh as the last Pages deploy, and asking a
 * cron for one is not the same as getting one: a 2-hourly schedule realised a
 * 4.5 h median gap and hourly realised 4.64 h. So the backend asks for the
 * deploy itself when a crawl lands. What these pin is that it cannot cost a
 * crawl — no token, a rejection, an exception: the board still ships.
 */
describe('mirror deploy dispatch', () => {
  const goodRows = plausibleRows();
  const withToken = () => {
    const back = loadBackend(goodRows);
    back.props.set(back.api.GH_DISPATCH_TOKEN_PROP, 'ghp_stub');
    return back;
  };

  it('posts exactly one dispatch when a refresh publishes a board', () => {
    const { api, dispatches } = withToken();
    const board = api.refreshBoardCache();

    expect(board.count).toBeGreaterThan(0);
    expect(dispatches).toHaveLength(1);
    const [{ url, options }] = dispatches;
    expect(url).toBe(api.GH_DISPATCH_URL);
    expect(options.method).toBe('post');
    expect(JSON.parse(options.payload as string)).toEqual({ event_type: api.GH_DISPATCH_EVENT });
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_stub');
    expect(headers.Accept).toBe('application/vnd.github+json');
  });

  it('does nothing at all with no token configured', () => {
    // The deployed state until the operator sets the property: the schedule in
    // `deploy-pages.yml` is the fallback, and this must not fail meanwhile.
    const { api, dispatches, logs } = loadBackend(goodRows);
    expect(api.refreshBoardCache().count).toBeGreaterThan(0);

    expect(dispatches).toHaveLength(0);
    expect(api.requestMirrorDeploy()).toBe('unconfigured');
    expect(logs.some((l) => l.includes('requestMirrorDeploy'))).toBe(false); // nor is it noise
  });

  it('never lets a dispatch failure cost a crawl', () => {
    const { api, breakDispatch, logs } = withToken();
    breakDispatch();

    const board = api.refreshBoardCache();
    expect(board.count).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('requestMirrorDeploy failed'))).toBe(true);
  });

  it('reports a rejection by status, and keeps the body out of the log', () => {
    // An expired PAT answers 401. That is the operator's problem, not a reason
    // to lose a crawl, and GitHub's error body is the last thing to paste into
    // a log beside the token that just failed.
    const { api, rejectDispatch, logs } = withToken();
    rejectDispatch(401);

    expect(api.requestMirrorDeploy()).toBe('rejected 401');
    expect(logs.some((l) => l === 'requestMirrorDeploy: GitHub answered 401')).toBe(true);
    expect(logs.some((l) => l.includes('ghp_stub'))).toBe(false);
    // …and it is visible where an operator looks, not only in a log nobody
    // opens: an expired PAT 401s on every crawl and the mirror quietly falls
    // back to the cron.
    expect(api.handleDiag().mirror_dispatch).toMatchObject({ outcome: 'rejected 401' });
    expect(JSON.stringify(api.handleDiag())).not.toContain('ghp_stub');
  });

  it('keeps a floor under the deploys a public ?action=warm can drive', () => {
    // `warm` needs no token and releases its lock when the crawl ends, so a
    // visitor can drive crawls every few minutes. A crawl is the backend's own
    // cost; a Pages deploy is a minute of CI against a soft limit of ten an
    // hour. The floor sits far below the 4 h refresh cycle it follows.
    const { api, dispatches, props } = withToken();
    api.refreshBoardCache();
    api.refreshBoardCache();
    expect(dispatches).toHaveLength(1);
    expect(api.requestMirrorDeploy()).toBe('throttled');

    // …and the crawl the mirror does not carry says so, rather than leaving
    // the older `dispatched` on screen as if nothing had been missed.
    expect(api.handleDiag().mirror_dispatch).toMatchObject({ outcome: 'throttled' });

    // Age the accepted dispatch past the floor and the next crawl publishes.
    props.set('veggie_mirror_dispatch_ok',
      new Date(Date.now() - api.GH_DISPATCH_MIN_INTERVAL_MS - 60_000).toISOString());
    api.refreshBoardCache();
    expect(dispatches).toHaveLength(2);
  });

  it('lets the next crawl retry after a rejection, which cost no deploy', () => {
    // The 30-minute floor exists to bound Pages deploys. A 401 or a 500
    // produced none, so holding the next crawl over it would only block the
    // retry that recovers from a transient failure — a much shorter backoff
    // does that job instead.
    const { api, rejectDispatch, dispatches, props } = withToken();
    rejectDispatch(500);
    api.refreshBoardCache();
    expect(dispatches).toHaveLength(1);

    props.set('veggie_mirror_dispatch',
      new Date(Date.now() - api.GH_DISPATCH_FAIL_BACKOFF_MS - 1000).toISOString() + ' rejected 500');
    api.refreshBoardCache();

    expect(dispatches).toHaveLength(2); // retried well inside the 30-minute floor
    expect(api.handleDiag().mirror_dispatch).toMatchObject({ outcome: 'rejected 500' });
  });

  it('does not hammer GitHub with a doomed request between crawls', () => {
    // An expired PAT beside a public `?action=warm` would otherwise POST every
    // few minutes for as long as anyone kept crawling, and get the token
    // secondary-rate-limited for it.
    const { api, rejectDispatch, dispatches } = withToken();
    rejectDispatch(401);
    api.refreshBoardCache();
    api.refreshBoardCache();
    api.refreshBoardCache();

    expect(dispatches).toHaveLength(1);
    expect(api.requestMirrorDeploy()).toBe('backoff');
    // The backoff is not what diag shows: the rejection it is backing off from
    // is the useful thing, and re-stamping it here would extend the window for
    // as long as something kept crawling.
    expect(api.handleDiag().mirror_dispatch).toMatchObject({ outcome: 'rejected 401' });
  });

  it('keeps the floor armed when the store can no longer take the record', () => {
    // Both keys can be new, and a rejected board has just written its chunks
    // into the same store. Losing the floor would let every later crawl spend
    // another Pages deploy; losing the record costs diag a line.
    const { api, dispatches, breakProp, props } = withToken();
    breakProp('veggie_mirror_dispatch');

    api.refreshBoardCache();
    api.refreshBoardCache();

    expect(dispatches).toHaveLength(1); // the floor was armed and held
    expect(props.has('veggie_mirror_dispatch_ok')).toBe(true);
    // …and diag says the mirror is deploying, not that nothing was ever tried.
    expect(api.handleDiag().mirror_dispatch).toMatchObject({ outcome: 'unknown' });
    expect(api.handleDiag().mirror_dispatch.last_ok).not.toBeNull();
  });

  it('says when the mirror was last actually asked to publish', () => {
    // Under a crawl every few minutes the outcome reads `throttled` almost
    // always. That says the newest board is not the published one; it cannot
    // say how old the published one is.
    const { api } = withToken();
    api.refreshBoardCache();
    const dispatched = api.handleDiag().mirror_dispatch;
    expect(dispatched.outcome).toBe('dispatched');
    expect(dispatched.last_ok).toBe(dispatched.at);

    api.refreshBoardCache(); // inside the floor
    const throttled = api.handleDiag().mirror_dispatch;
    expect(throttled.outcome).toBe('throttled');
    expect(throttled.last_ok).toBe(dispatched.at);
  });

  it('shows nothing at all in diag until something has been attempted', () => {
    const { api } = loadBackend(goodRows);
    api.refreshBoardCache(); // no token: nothing attempted, nothing recorded
    expect(api.handleDiag().mirror_dispatch).toBeNull();
  });

  it('asks for no deploy when the board was rejected', () => {
    // A deploy publishes whatever `?action=board` answers at the time, and a
    // rejected board leaves the previous one on air: there is nothing new to
    // mirror, and a dispatch would only spend a deploy saying so.
    const { api, dispatches } = withToken();
    const bare = loadBackend(); // no MOA rows → empty build → rejected
    bare.props.set(bare.api.GH_DISPATCH_TOKEN_PROP, 'ghp_stub');

    bare.api.refreshBoardCache();
    expect(bare.dispatches).toHaveLength(0);
    // …and the same harness does dispatch when the board is good.
    api.refreshBoardCache();
    expect(dispatches).toHaveLength(1);
  });
});

/**
 * The long-term history Sheet (#22).
 *
 * The rolling 28-day store in ScriptProperties is untouched and still what
 * every baseline is measured against; this is one more copy, in a spreadsheet
 * the deployer owns, for the comparisons that quota cannot hold. What has to
 * hold: it is off until configured, it costs the board nothing when it fails,
 * and a trading day lands in it exactly once.
 */
describe('long-term history in a Sheet', () => {
  const goodRows = plausibleRows();
  const SHEET_ID = '1AbCdEfGh_stub';

  /** A board as `buildBoard` shapes one, crawled `hoursAgo` ago. */
  const boardOf = (date: string, hoursAgo = 0, over: Record<string, unknown> = {}) => ({
    type: 'board',
    date,
    roc_date: '115.09.21',
    generated_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    count: 2,
    items: [
      {
        code: 'LA1', name: '高麗菜', official_name: '甘藍', category: '葉菜類',
        avg_price: 22.1, catty_price: 13.3, change_percent: -1.5, trade_volume: 570700,
        unit: '公斤', markets_count: 13,
        varieties: [
          { name: '初秋', catty_price: 12, retail_price: 20, share_percent: 61 },
          { name: '雪翠', catty_price: 15, retail_price: 25, share_percent: 22 },
        ],
      },
      {
        code: 'FF2', name: '番茄', official_name: '番茄', category: '果菜類',
        avg_price: 40, catty_price: 24, change_percent: 3, trade_volume: 12000,
        unit: '公斤', markets_count: 6,
      },
    ],
    ...over,
  });

  describe('historyRowsFor — what actually gets archived', () => {
    it('writes one blend row per item and one per variety', () => {
      const { api } = loadBackend();
      const rows = api.historyRowsFor(boardOf('2026-09-21')) as unknown[][];

      expect(rows).toHaveLength(4); // 2 items + 2 varieties on the first
      expect(rows[0]).toEqual(['2026-09-21', '高麗菜', '甘藍', '', 22.1, 570700, 13, '']);
      // The variety row carries the share, not a volume nobody measured: the
      // breakdown publishes shares and prices and drops the volume it grouped
      // by, so `share × total` would be an invented number in an archive.
      expect(rows[1]).toEqual(['2026-09-21', '高麗菜', '甘藍', '初秋', 20, '', '', 61]);
      expect(rows[3]).toEqual(['2026-09-21', '番茄', '番茄', '', 40, 12000, 6, '']);
    });

    it('converts the variety price back to the column\'s unit', () => {
      // The card publishes 元/台斤; every price in this column is 元/公斤, so
      // one unit reads down the whole archive.
      const { api } = loadBackend();
      const rows = api.historyRowsFor(boardOf('2026-09-21')) as unknown[][];
      expect(rows[1][4]).toBe(20); // 12 元/台斤 ÷ 0.6
      expect(rows[2][4]).toBe(25); // 15 元/台斤 ÷ 0.6
    });

    it('skips an item the plausibility guard flagged', () => {
      // Same reason `updateHistory` skips it: an archive exists to be measured
      // against later, and a flagged observation must not bend that.
      const { api } = loadBackend();
      const board = boardOf('2026-09-21');
      board.items[0].suspect = true;
      const rows = api.historyRowsFor(board) as unknown[][];

      expect(rows).toHaveLength(1);
      expect(rows[0][1]).toBe('番茄');
    });

    it('matches the header it is written under', () => {
      const { api } = loadBackend();
      const rows = api.historyRowsFor(boardOf('2026-09-21')) as unknown[][];
      for (const row of rows) expect(row).toHaveLength(api.SHEET_HEADER.length);
    });
  });

  describe('appendDailyHistory', () => {
    const configured = () => {
      const back = loadBackend(goodRows);
      back.props.set(back.api.HISTORY_SHEET_ID_PROP, SHEET_ID);
      return back;
    };

    it('does nothing at all until a sheet is configured', () => {
      // How this ships. Nothing is opened, nothing is written, and the refresh
      // behaves exactly as it did.
      const { api, openedIds, tabs } = loadBackend(goodRows);
      expect(api.refreshBoardCache().count).toBeGreaterThan(0);

      expect(api.appendDailyHistory(boardOf('2026-09-21'))).toBe('unconfigured');
      expect(openedIds).toEqual([]);
      expect(tabs.size).toBe(0);
      expect(api.handleDiag().sheet_history).toEqual({
        configured: false, last_write: null, backfill: null, year_ago: null,
      });
    });

    it('creates the year tab with its header and appends the day', () => {
      const { api, tabs, openedIds } = configured();
      expect(api.appendDailyHistory(boardOf('2026-09-21'))).toBe('appended');

      expect(openedIds).toEqual([SHEET_ID]);
      const rows = (tabs.get('2026') as { rows: unknown[][] }).rows;
      expect(rows[0]).toEqual(api.SHEET_HEADER);
      expect(rows).toHaveLength(5); // header + 4
      expect(rows[1][0]).toBe('2026-09-21');
    });

    it('writes a trading day once, however often the refresh revisits it', () => {
      // The refresh runs every 4 h and re-crawls the same day.
      const { api, tabs } = configured();
      api.appendDailyHistory(boardOf('2026-09-21'));
      expect(api.appendDailyHistory(boardOf('2026-09-21'))).toBe('already written');
      expect((tabs.get('2026') as { rows: unknown[][] }).rows).toHaveLength(5);
    });

    it('replaces the day when the numbers have moved on', () => {
      // MOA completes a day's closing prices through the evening, so a crawl
      // of the same date hours later is a correction, not a duplicate.
      const { api, tabs } = configured();
      api.appendDailyHistory(boardOf('2026-09-21', 8));

      const corrected = boardOf('2026-09-21');
      corrected.items[1].avg_price = 41.5;
      expect(api.appendDailyHistory(corrected)).toBe('replaced');

      const rows = (tabs.get('2026') as { rows: unknown[][] }).rows;
      expect(rows).toHaveLength(5); // still one day, not two
      expect(rows[4][4]).toBe(41.5);
    });

    it('keeps other days intact when it replaces one', () => {
      const { api, tabs } = configured();
      api.appendDailyHistory(boardOf('2026-09-20', 30));
      api.appendDailyHistory(boardOf('2026-09-21', 8));
      const corrected = boardOf('2026-09-21');
      corrected.items[1].avg_price = 41.5;
      api.appendDailyHistory(corrected);

      const rows = (tabs.get('2026') as { rows: unknown[][] }).rows;
      const dates = rows.slice(1).map((r) => r[0]);
      expect(dates.filter((d) => d === '2026-09-20')).toHaveLength(4);
      expect(dates.filter((d) => d === '2026-09-21')).toHaveLength(4);
    });

    it('puts each year in its own tab', () => {
      const { api, tabs } = configured();
      api.appendDailyHistory(boardOf('2026-12-31', 30));
      api.appendDailyHistory(boardOf('2027-01-02'));

      expect([...tabs.keys()]).toEqual(['2026', '2027']);
      expect((tabs.get('2027') as { rows: unknown[][] }).rows).toHaveLength(5);
    });

    it('keeps a malformed board inside its own failure, not the lock\'s', () => {
      // `historyRowsFor` reads a board the crawl built. If that ever throws,
      // it has to be caught where it happened: outside the try it would
      // surface as lock contention and log the wrong cause.
      const { api, logs } = configured();
      const broken = boardOf('2026-09-21');
      broken.items = [null] as unknown as typeof broken.items;

      expect(api.appendDailyHistory(broken)).toBe('failed');
      expect(logs.some((l) => l.includes('archiveDay failed'))).toBe(true);
      expect(logs.some((l) => l.includes('appendDailyHistory skipped'))).toBe(false);
    });

    it('never lets a Sheets failure cost the board', () => {
      const { api, breakSheet, logs, props } = configured();
      breakSheet();

      const board = api.refreshBoardCache();
      expect(board.count).toBeGreaterThan(0);
      expect(props.get('veggie_last_refresh_ok')).toBeTruthy();
      expect(logs.some((l) => l.includes('archiveDay failed'))).toBe(true);
      // And nothing is recorded, so the next refresh tries the same day again.
      expect(props.has('veggie_sheet_last_write')).toBe(false);
    });

    it('grows the grid it is writing into', () => {
      // A tab is a fixed grid and `setValues` does not expand it: at ~160 rows
      // a trading day, a default 1000-row tab is full inside a week, and every
      // write after that throws out of bounds — an archive that dies on about
      // day five with nothing but a log line to show for it.
      const { api, tabs } = configured();
      const dayOf = (n: number) => {
        const board = boardOf(`2026-09-${String(n).padStart(2, '0')}`, (9 - n) * 24);
        board.items = Array.from({ length: 180 }, (_, i) => ({
          ...board.items[1], code: `X${i}`, name: `菜${i}`, official_name: `菜${i}`,
        }));
        return board;
      };
      for (let day = 1; day <= 8; day++) expect(api.appendDailyHistory(dayOf(day))).toBe('appended');

      const tab = tabs.get('2026') as { rows: unknown[][]; maxRows: number };
      expect(tab.rows).toHaveLength(8 * 180 + 1); // 1441 rows, past the 1000 a new tab has
      expect(tab.maxRows).toBeGreaterThanOrEqual(tab.rows.length);
    });

    it('keeps the date column text, so a replacement can find its own day', () => {
      // Left as a date, Sheets parses `2026-09-21` into a value it hands back
      // as a `Date`, `dropDay` matches nothing, and the "replacement"
      // duplicates the day instead.
      const { api, tabs } = configured();
      api.appendDailyHistory(boardOf('2026-09-21', 8));
      const tab = tabs.get('2026') as { rows: unknown[][]; textColumnA: boolean };
      expect(tab.textColumnA).toBe(true);
      expect(tab.rows[1][0]).toBe('2026-09-21');

      api.appendDailyHistory(boardOf('2026-09-21'));
      expect(tab.rows).toHaveLength(5);
    });

    it('still finds the day when the column holds real dates', () => {
      // A tab someone reformatted by hand, or one written before the format
      // was set. The comparison normalises rather than trusting the cell type.
      const { api, tabs } = configured();
      api.appendDailyHistory(boardOf('2026-09-21', 8));
      const tab = tabs.get('2026') as { rows: unknown[][]; textColumnA: boolean };
      tab.textColumnA = false;
      tab.rows = tab.rows.map((row, i) => (i === 0 ? row : [new Date('2026-09-21T00:00:00'), ...row.slice(1)]));

      const corrected = boardOf('2026-09-21');
      corrected.items[1].avg_price = 41.5;
      expect(api.appendDailyHistory(corrected)).toBe('replaced');
      expect(tab.rows).toHaveLength(5);
    });

    it('rewrites a day only when its numbers have moved', () => {
      // The board keeps a trading date until the next one publishes, so over a
      // weekend the same unchanged Friday is re-crawled for days. What decides
      // is the rows, not the clock — and the clock only keeps the comparison
      // itself cheap.
      const { api, tabs, props } = configured();
      api.appendDailyHistory(boardOf('2026-09-18', 48));

      // The evening completion: better numbers for the same day.
      const completed = boardOf('2026-09-18', 40);
      completed.items[1].avg_price = 41.5;
      expect(api.appendDailyHistory(completed)).toBe('replaced');

      // And then the same numbers, again and again, for the rest of the break.
      expect(api.appendDailyHistory(boardOf('2026-09-18', 24, { items: completed.items }))).toBe('unchanged');
      expect(api.appendDailyHistory(boardOf('2026-09-18', 8, { items: completed.items }))).toBe('unchanged');
      // …with the crawl time recorded each time, so the next revisit inside
      // the window is skipped without reading the sheet at all.
      expect(api.appendDailyHistory(boardOf('2026-09-18', 6, { items: completed.items }))).toBe('already written');

      expect((tabs.get('2026') as { rows: unknown[][] }).rows).toHaveLength(5);
      expect(props.get('veggie_sheet_last_write')).toContain('2026-09-18');
    });

    it('reads a date cell in the spreadsheet\'s timezone, not the script\'s', () => {
      // A date cell is an instant, and only a calendar date in some zone. Read
      // in the wrong one, a sheet kept east of Asia/Taipei lands on the day
      // before and the replacement finds nothing — the bug the text column
      // exists to avoid, reintroduced by the fallback that tolerates it.
      const { api, tabs, formatZones, setSheetZone } = configured();
      setSheetZone('Pacific/Auckland');
      api.appendDailyHistory(boardOf('2026-09-21', 8));

      const tab = tabs.get('2026') as { rows: unknown[][]; textColumnA: boolean };
      tab.textColumnA = false;
      tab.rows = tab.rows.map((row, i) => (i === 0 ? row : [new Date('2026-09-20T20:00:00'), ...row.slice(1)]));

      const corrected = boardOf('2026-09-21');
      corrected.items[1].avg_price = 41.5;
      expect(api.appendDailyHistory(corrected)).toBe('replaced');
      expect(tab.rows).toHaveLength(5); // replaced, not duplicated
      expect(formatZones).toContain('Pacific/Auckland');
    });

    it('sees an unchanged day on a date-formatted tab as unchanged', () => {
      // The other half of reading those cells: if the comparison then treats
      // the `Date` in column 0 as a difference, every day looks changed and
      // the archive rewrites it every window for as long as the market is
      // shut — which is what the comparison replaced.
      const { api, tabs } = configured();
      api.appendDailyHistory(boardOf('2026-09-21', 8));
      const tab = tabs.get('2026') as { rows: unknown[][]; textColumnA: boolean };
      tab.textColumnA = false;
      tab.rows = tab.rows.map((row, i) => (i === 0 ? row : [new Date('2026-09-21T00:00:00'), ...row.slice(1)]));

      expect(api.appendDailyHistory(boardOf('2026-09-21'))).toBe('unchanged');
      expect(tab.rows).toHaveLength(5);
    });

    it('does not drop the day for a board it would write nothing for', () => {
      // Every item flagged: the rows are built before anything is deleted, so
      // a correction that has nothing to say leaves what is there alone.
      const { api, tabs } = configured();
      api.appendDailyHistory(boardOf('2026-09-21', 8));
      const allFlagged = boardOf('2026-09-21');
      allFlagged.items.forEach((it: Record<string, unknown>) => { it.suspect = true; });

      expect(api.appendDailyHistory(allFlagged)).toBe('nothing to write');
      expect((tabs.get('2026') as { rows: unknown[][] }).rows).toHaveLength(5);
    });

    it('serialises with the other history write, and never throws on contention', () => {
      // Two executions genuinely overlap — the 4-hourly trigger and a
      // `?action=warm` rebuild — and a check-then-append race would archive
      // the day twice.
      const { api, contendLock, tabs } = configured();
      api.appendDailyHistory(boardOf('2026-09-21', 8));
      contendLock();

      expect(() => api.appendDailyHistory(boardOf('2026-09-20', 30))).not.toThrow();
      expect((tabs.get('2026') as { rows: unknown[][] }).rows).toHaveLength(5); // nothing added
    });

    it('is driven by the refresh, and says so in diag without reading the sheet', () => {
      const { api, tabs, openedIds } = configured();
      api.refreshBoardCache();

      expect(tabs.size).toBe(1);
      const opens = openedIds.length;
      const diag = api.handleDiag();
      expect(diag.sheet_history.configured).toBe(true);
      expect(diag.sheet_history.last_write.date).toBe(api.readBoard().date);
      // `diag` is public: a spreadsheet read here would let anyone spend the
      // deployment's Sheets quota.
      expect(openedIds).toHaveLength(opens);
      expect(JSON.stringify(diag)).not.toContain(SHEET_ID);
    });
  });
});

/** ROC date arithmetic, for the suites below that work on fixed dates. */
const rocShift = (roc: string, days: number): string => {
  const [y, m, d] = roc.split('.').map(Number);
  const at = new Date(Date.UTC(y + 1911, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCFullYear() - 1911}.${pad(at.getUTCMonth() + 1)}.${pad(at.getUTCDate())}`;
};
const rocIso = (roc: string): string => {
  const [y, m, d] = roc.split('.');
  return `${Number(y) + 1911}-${m}-${d}`;
};

/**
 * MOA's range endpoint over a day-by-day world: `daily(root, roc)` says what
 * traded, and a response past `cap` rows is cut the way MOA cuts one — the
 * newest rows kept and `Next: true` set. A day answering `null` makes the
 * whole request come back as MOA answers a burst: an empty body.
 */
function moaRange(daily: (root: string, roc: string) => Row[] | null | 'error' | 'bare' | 'cut', cap = Infinity) {
  const requests: { root: string; from: string; to: string }[] = [];
  const answer = (url: string) => {
    const q = new URL(url).searchParams;
    const root = q.get('CropName') ?? '';
    const from = q.get('Start_time') ?? '';
    const to = q.get('End_time') ?? from;
    requests.push({ root, from, to });
    let rows: Row[] = [];
    let silent = false;
    let error = false;
    let bare = false;
    let cut = false;
    for (let d = from; d <= to; d = rocShift(d, 1)) {
      const day = daily(root, d);
      if (day === null) silent = true;
      else if (day === 'error') error = true;
      else if (day === 'bare') bare = true;
      else if (day === 'cut') cut = true;
      else rows = rows.concat(day);
    }
    if (cut && !silent) {
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ RS: 'OK', Data: rows, Next: true }) };
    }
    if (bare) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ RS: 'OK' }) };
    if (silent) return { getResponseCode: () => 200, getContentText: () => '' };
    if (error) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ RS: 'ERROR', Message: 'busy' }) };
    const next = rows.length > cap;
    if (next) rows = [...rows].sort((a, b) => (b.TransDate ?? '').localeCompare(a.TransDate ?? '')).slice(0, cap);
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ RS: 'OK', Data: rows, Next: next }),
    };
  };
  return {
    requests,
    UrlFetchApp: {
      fetch: (url: string) => answer(url),
      fetchAll: (reqs: { url: string }[]) => reqs.map((r) => answer(r.url)),
    },
  };
}

describe('backfilling the archive from MOA (#22 §4)', () => {
  const SHEET_ID = '1AbCdEfGh_stub';
  const BOARD_ROC = '115.09.21';
  const CLOSED = new Set(['115.09.13']);

  /**
   * Every board item trading every open day, as a real day has them — the
   * guard refuses a day of a handful of items. Two are shaped for the tests:
   * 高麗菜 in two varieties (a blend row and two variety rows) and 番茄 in one;
   * every other item is one row at a steady price, so one archive row.
   */
  const ITEMS: GuardDef[] = loadBackend().api.BOARD_ITEMS;
  const FILLER: Record<string, string[]> = {};
  for (const def of ITEMS) {
    if (def.official === '甘藍' || def.official === '番茄') continue;
    (FILLER[def.official] ??= []).push(def.official + (def.variety ? `-${def.variety}` : ''));
  }
  const market = (root: string, roc: string): Row[] => {
    if (CLOSED.has(roc)) return root === '甘藍' ? [trendRow(roc, '休市', 0, 0)] : [];
    if (root === '甘藍') {
      return [trendRow(roc, '甘藍-初秋', 20, 60000), trendRow(roc, '甘藍-雪翠', 30, 40000, '台中')];
    }
    if (root === '番茄') return [trendRow(roc, '番茄-牛番茄', 40, 12000)];
    return (FILLER[root] ?? []).map((name) => trendRow(roc, name, 20, 60000));
  };
  const ROWS_A_DAY = 4 + (ITEMS.length - 2);

  const backfill = (
    daily: (root: string, roc: string) => Row[] | null | 'error' | 'bare' | 'cut' = market,
    { cap = Infinity, boardRoc = BOARD_ROC, overrides = {} as Record<string, unknown> } = {},
  ) => {
    const moa = moaRange((root, roc) => daily(root, roc), cap);
    const back = loadBackend({}, { UrlFetchApp: moa.UrlFetchApp, ...overrides });
    back.props.set(back.api.HISTORY_SHEET_ID_PROP, SHEET_ID);
    back.api.storeBoard({
      type: 'board', date: rocIso(boardRoc), roc_date: boardRoc,
      generated_at: new Date().toISOString(), count: 0, items: [],
    });
    const job = () => JSON.parse(back.props.get(back.api.SHEET_BACKFILL_PROP) ?? 'null');
    const setJob = (patch: Record<string, unknown>) =>
      back.props.set(back.api.SHEET_BACKFILL_PROP, JSON.stringify({ ...job(), ...patch }));
    const rowsOf = (year: string) => (back.tabs.get(year)?.rows ?? []).slice(1);
    const datesOf = (year: string) => [...new Set(rowsOf(year).map((r) => r[0]))].sort();
    const links = () => back.triggers.filter((t) => t.handler === back.api.SHEET_BACKFILL_FN).length;
    return { ...back, moa, job, setJob, rowsOf, datesOf, links };
  };

  describe('the request', () => {
    it('refuses until a sheet is configured', () => {
      const back = backfill();
      back.props.delete(back.api.HISTORY_SHEET_ID_PROP);
      const reply = back.api.handleSheetBackfill({ months: '12' });
      expect(reply).toMatchObject({ sheet: true, queued: false, message: '尚未設定 HISTORY_SHEET_ID' });
      expect(back.job()).toBeNull();
      expect(back.links()).toBe(0);
    });

    it('stays behind the admin token, like the rolling backfill', () => {
      const back = backfill();
      expect(back.get({ action: 'backfill', sheet: '1', months: '12' }).error).toBe('unauthorized');
      expect(back.job()).toBeNull();

      back.props.set(back.api.ADMIN_TOKEN_PROP, 's3cret-token');
      expect(back.get({ action: 'backfill', sheet: '1', months: '12', token: 's3cret-token' }).queued).toBe(true);
    });

    it('answers a status request without crawling or queueing anything', () => {
      const back = backfill();
      const reply = back.api.handleSheetBackfill({});
      expect(reply).toMatchObject({ queued: false, job: null });
      expect(reply.archive).toMatchObject({ rows: 0, days: 0, first_date: null, last_date: null });
      expect(back.moa.requests).toHaveLength(0);
      expect(back.links()).toBe(0);
    });

    it('queues a job that stops the day before the board\'s trading date', () => {
      // The live archive only ever writes the board's date or a later one, and
      // it appends a new date without looking. A day both had written would be
      // in the Sheet twice.
      const back = backfill();
      const reply = back.api.handleSheetBackfill({ months: '12' });

      expect(reply.queued).toBe(true);
      expect(back.job()).toMatchObject({
        status: 'running', months: 12, from: '2025-09-21', to: '2026-09-20', cursor: '2026-09-20',
      });
      expect(back.links()).toBe(1);
      expect(back.moa.requests).toHaveLength(0); // the crawl is the trigger's, never the request's
    });

    it('clamps a long reach, and refuses one it cannot read', () => {
      // `months=0` reads like "nothing"; answering it with a year of crawling
      // is the one reading that costs a day's trigger quota.
      expect(backfill().api.handleSheetBackfill({ months: '99' }).job.months).toBe(24);
      for (const months of ['0', 'soon', '-3', '1.5']) {
        const back = backfill();
        expect(back.api.handleSheetBackfill({ months }).message).toBe('months 需為 1–24 的整數');
        expect(back.job()).toBeNull();
        expect(back.links()).toBe(0);
      }
    });

    it('cancels only on cancel=1, and backfills the Sheet only on sheet=1', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.api.handleSheetBackfill({ cancel: '0' });
      expect(back.job().status).toBe('running');

      // Nor does a typo for sheet=1 fall through to the rolling seed and its
      // hour-long queue lock.
      back.props.set(back.api.ADMIN_TOKEN_PROP, 's3cret-token');
      expect(back.get({ action: 'backfill', sheet: 'true', token: 's3cret-token' }).message).toBe('sheet 參數只接受 1');
      expect(back.cache.has('veggie_backfill_queued')).toBe(false);
    });

    it('reaches back whole months, even from a month\'s last day', () => {
      // `setMonth` alone rolls 03-31 less one month on to 03-03.
      const back = backfill(market, { boardRoc: '115.04.01' }); // ends 03-31
      expect(back.api.handleSheetBackfill({ months: '1' }).job.from).toBe('2026-03-01');
      const leap = backfill(market, { boardRoc: '115.03.31' });
      expect(leap.api.handleSheetBackfill({ months: '1' }).job.from).toBe('2026-02-28');
    });

    it('answers "busy" rather than racing another request', () => {
      // Two requests at once could each decide there is no job and start one
      // apiece, leaving two chains on one cursor.
      const back = backfill();
      back.contendLock();
      expect(back.api.handleSheetBackfill({ months: '12' }).message).toBe('系統忙碌中，請稍後再試');
      expect(back.job()).toBeNull();
      expect(back.links()).toBe(0);
    });

    it('will not start without a board to measure the end from', () => {
      const back = backfill();
      back.props.clear();
      back.props.set(back.api.HISTORY_SHEET_ID_PROP, SHEET_ID);
      expect(back.api.handleSheetBackfill({ months: '12' }).message).toBe('尚無看板，無法決定回填終點');
      expect(back.links()).toBe(0);
    });

    it('reports a running job instead of starting a second one', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      const first = back.job();

      const again = back.api.handleSheetBackfill({ months: '3' });
      expect(again).toMatchObject({ queued: false, message: '回填進行中' });
      expect(back.job()).toEqual(first);
      expect(back.links()).toBe(1);
    });

    it('keeps the count of a stalled chain, which a killed link may have stopped', () => {
      // A link killed by the 6-minute limit never reaches its `catch`, so it
      // was counted before it started. Resuming it must not forget that, or a
      // window that always runs too long would be resumed for ever.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.triggers.length = 0;
      back.setJob({ failures: 2, updated_at: new Date(Date.now() - back.api.SHEET_BACKFILL_STALL_MS - 60_000).toISOString() });

      back.api.handleSheetBackfill({ months: '12' });
      expect(back.job().failures).toBe(2);

      back.setJob({ failures: back.api.SHEET_BACKFILL_MAX_FAILURES }); // …and the resumed link dies too
      back.api.sheetBackfillStep();
      expect(back.job().status).toBe('failed');
      expect(back.job().last_error).toContain('did not finish');
      expect(back.moa.requests).toHaveLength(0);
      expect(back.links()).toBe(0);
    });

    it('says a stalled job whose failures are spent has failed, not that it is queued', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.triggers.length = 0;
      back.setJob({
        failures: back.api.SHEET_BACKFILL_MAX_FAILURES,
        updated_at: new Date(Date.now() - back.api.SHEET_BACKFILL_STALL_MS - 60_000).toISOString(),
      });

      const reply = back.api.handleSheetBackfill({ months: '12' });
      expect(reply.queued).toBe(false);
      expect(reply.message).toContain('回填已失敗');
      expect(back.job().status).toBe('failed');
      expect(back.api.handleSheetBackfill({ months: '12' }).queued).toBe(true); // asking again retries
    });

    it('resumes a job whose chain stopped, from where it got to', () => {
      // One link runs for at most six minutes and queues the next a second
      // later, so a running job this quiet has nothing behind it.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();
      back.triggers.length = 0; // the next link never fired
      back.setJob({ updated_at: new Date(Date.now() - back.api.SHEET_BACKFILL_STALL_MS - 60_000).toISOString() });

      const reply = back.api.handleSheetBackfill({ months: '12' });
      expect(reply.queued).toBe(true);
      expect(reply.message).toBe('已從 2026-09-11 繼續回填');
      expect(back.job()).toMatchObject({ months: 12, cursor: '2026-09-11', windows: 1 });
      expect(back.links()).toBe(1);
    });

    it('replaces a failed job when asked for a different reach', () => {
      // Resuming is for the same reach. Otherwise a failed job would swallow
      // every later request, and only deleting the property would free it.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep(); // 09-12 … 09-20 written
      back.setJob({ status: 'failed' });
      const old = back.job();

      const reply = back.api.handleSheetBackfill({ months: '24' });
      expect(reply.queued).toBe(true);
      expect(back.job().id).not.toBe(old.id);
      expect(back.job()).toMatchObject({ months: 24, cursor: '2026-09-20', skip: [{ from: '2026-09-12', to: '2026-09-20' }] });
    });

    it('will not replace a job whose last link may still be running', () => {
      // That link could finish and write its job back over the new one.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.setJob({ status: 'cancelled', link_open: true, link_started_at: new Date().toISOString() });

      expect(back.api.handleSheetBackfill({ months: '12' }).message).toBe('上一批次仍在執行，請數分鐘後再試');
      expect(back.job().status).toBe('cancelled');

      // Past the execution limit it cannot be running any more.
      back.setJob({ link_started_at: new Date(Date.now() - 8 * 60_000).toISOString() });
      expect(back.api.handleSheetBackfill({ months: '12' }).queued).toBe(true);
    });

    it('cancels a running job and its queued link', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      expect(back.api.handleSheetBackfill({ cancel: '1' }).message).toBe('已停止回填');
      expect(back.job().status).toBe('cancelled');
      expect(back.links()).toBe(0);

      back.api.sheetBackfillStep(); // a link already in flight does nothing
      expect(back.moa.requests).toHaveLength(0);
    });
  });

  describe('one link', () => {
    it('crawls one window per root and writes its trading days', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      // One request per root, twelve days long: nine written, three before
      // them fetched only to be the previous trading day.
      const cabbage = back.moa.requests.filter((r) => r.root === '甘藍');
      expect(cabbage).toEqual([{ root: '甘藍', from: '115.09.09', to: '115.09.20' }]);

      expect(back.datesOf('2026')).toEqual([
        '2026-09-12', '2026-09-14', '2026-09-15', '2026-09-16',
        '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20',
      ]); // 09-13 was closed; 09-09 to 09-11 are the next window's
      expect(back.rowsOf('2026')).toHaveLength(8 * ROWS_A_DAY);
      expect(back.job()).toMatchObject({
        status: 'running', cursor: '2026-09-11', windows: 1,
        days_written: 8, days_skipped: 0, rows_written: 8 * ROWS_A_DAY, failures: 0,
      });
      expect(back.links()).toBe(1); // the next one
    });

    it('builds a day the way the live archive does', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      const day = back.rowsOf('2026').filter((r) => r[0] === '2026-09-20' && (r[1] === '高麗菜' || r[1] === '番茄'));
      expect(day).toEqual([
        ['2026-09-20', '高麗菜', '甘藍', '', 24, 100000, 2, ''],
        ['2026-09-20', '高麗菜', '甘藍', '初秋', 20, '', '', 60],
        ['2026-09-20', '高麗菜', '甘藍', '雪翠', 30, '', '', 40],
        ['2026-09-20', '番茄', '番茄', '', 40, 12000, 1, ''],
      ]);
    });

    it('judges the first day of a window against the day before it', () => {
      // The three leading days are why: rule (e) compares a day with the
      // previous TRADING day, and without them the first day of every window
      // would go into the archive unjudged.
      const spiked = (root: string, roc: string): Row[] => {
        if (root === '番茄' && roc === '115.09.11') return [trendRow(roc, '番茄-牛番茄', 10, 200000)];
        return market(root, roc); // …then 4× the price on a sixteenth of the volume
      };
      const back = backfill(spiked);
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      const itemsOn = (date: string) => back.rowsOf('2026').filter((r) => r[0] === date).map((r) => r[1]);
      expect(itemsOn('2026-09-12')).not.toContain('番茄'); // flagged, and skipped like the live path skips it
      expect(itemsOn('2026-09-12')).toContain('高麗菜');
      expect(itemsOn('2026-09-14')).toContain('番茄'); // judged against 09-12, which it matches
    });

    it('leaves a day already in the Sheet alone', () => {
      const back = backfill();
      const live = {
        type: 'board', date: '2026-09-18', roc_date: '115.09.18', generated_at: new Date().toISOString(),
        items: [{ name: '高麗菜', official_name: '甘藍', avg_price: 22, trade_volume: 90000, markets_count: 5 }],
      };
      expect(back.api.appendDailyHistory(live)).toBe('appended');
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      const day = back.rowsOf('2026').filter((r) => r[0] === '2026-09-18');
      expect(day).toEqual([['2026-09-18', '高麗菜', '甘藍', '', 22, 90000, 5, '']]); // the live row, alone
      expect(back.job()).toMatchObject({ days_written: 7, days_skipped: 1 });
    });

    it('freezes the header, so sorting the tab in the UI leaves it on row 1', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();
      expect(back.tabs.get('2026')?.frozen).toBe(1);
    });

    it('writes each year into its own tab', () => {
      const back = backfill(market, { boardRoc: '115.01.05' });
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.datesOf('2026')).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
      expect(back.datesOf('2025')).toEqual([
        '2025-12-27', '2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31',
      ]);
      expect(back.tabs.get('2025')?.rows[0]).toEqual(back.api.SHEET_HEADER);
    });

    it('retries a failed crawl, and stops the chain once it keeps failing', () => {
      // A probe root with no rows at all is a crawl that failed — MOA answers
      // a closed market with 休市 rows — and must not pass for a closed week.
      const back = backfill(() => null); // MOA silent: every request an empty body
      back.api.handleSheetBackfill({ months: '12' });

      back.api.sheetBackfillStep();
      expect(back.job()).toMatchObject({ status: 'running', failures: 1, cursor: '2026-09-20' });
      expect(back.job().last_error).toContain('甘藍');
      expect(back.links()).toBe(1);

      for (let i = 1; i < back.api.SHEET_BACKFILL_MAX_FAILURES; i++) back.api.sheetBackfillStep();
      expect(back.job()).toMatchObject({ status: 'failed', failures: back.api.SHEET_BACKFILL_MAX_FAILURES });
      expect(back.links()).toBe(0);
      expect(back.tabs.size).toBe(0);

      // …and asking again picks it up where it stopped.
      const reply = back.api.handleSheetBackfill({ months: '12' });
      expect(reply.message).toBe('已從 2026-09-20 繼續回填');
      expect(back.job()).toMatchObject({ status: 'running', failures: 0 });
    });

    it('records a sheet it cannot open as a failed link, never a thrown trigger', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.breakSheet();

      expect(() => back.api.sheetBackfillStep()).not.toThrow();
      expect(back.job()).toMatchObject({ status: 'running', failures: 1, cursor: '2026-09-20' });
      expect(back.job().last_error).toContain('Requested entity was not found');
    });

    it('arms a watchdog while it works, and swaps it for the next link after', () => {
      // A link the 6-minute limit kills never reaches its `finally`; the
      // watchdog is what follows it.
      let during: string[] = [];
      const back = backfill((root, roc) => {
        if (!during.length) during = back.triggers.filter((t) => t.handler === back.api.SHEET_BACKFILL_FN).map((t) => t.kind);
        return market(root, roc);
      });
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(during).toEqual(['after:480000']); // the spent trigger gone, the watchdog in its place
      expect(back.triggers.filter((t) => t.handler === back.api.SHEET_BACKFILL_FN).map((t) => t.kind))
        .toEqual(['after:1000']);
    });

    it('retries a window after a killed link, when the watchdog fires', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      // What a killed link leaves: counted, open, started past the limit.
      back.setJob({ failures: 1, link_open: true, link_started_at: new Date(Date.now() - 8 * 60_000).toISOString() });

      back.api.sheetBackfillStep();
      expect(back.job()).toMatchObject({ windows: 1, failures: 0, link_open: false });
    });

    it('leaves a job alone while another of its links is running', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.setJob({ link_open: true, link_started_at: new Date().toISOString() });
      const before = back.triggers.map((t) => t.kind);

      back.api.sheetBackfillStep();
      expect(back.moa.requests).toHaveLength(0);
      expect(back.triggers.map((t) => t.kind)).toEqual(before);
    });

    it('keeps a day the probe root truncated on in the trading calendar', () => {
      // More than a thousand rows of 甘藍 is a trading day; dropping it from
      // the calendar would judge the next day against the one before it.
      const heavy = (root: string, roc: string): Row[] => {
        if (root === '甘藍' && roc === '115.09.15') {
          return Array.from({ length: 6 }, (_, i) => trendRow(roc, '甘藍-初秋', 20, 20000, `市場${i}`));
        }
        if (root === '番茄' && roc === '115.09.14') return [trendRow(roc, '番茄-牛番茄', 10, 200000)];
        return market(root, roc);
      };
      const back = backfill(heavy, { cap: 5 });
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      const itemsOn = (date: string) => back.rowsOf('2026').filter((r) => r[0] === date).map((r) => r[1]);
      expect(itemsOn('2026-09-16')).toContain('番茄'); // judged against 09-15, not the spike on 09-14
      expect(back.logs.some((l) => l.includes('still truncates on 115.09.15'))).toBe(true);
    });

    it('writes a window without a crop MOA keeps refusing, on record', () => {
      // One crop refused every time, the probe answering throughout: a
      // refusal of that crop, and the rest of the window is worth having.
      const back = backfill((root, roc) => (root === '番茄' ? null : market(root, roc)));
      back.api.handleSheetBackfill({ months: '12' });
      for (let i = 0; i < back.api.SHEET_BACKFILL_MAX_FAILURES; i++) back.api.sheetBackfillStep();

      expect(back.job()).toMatchObject({ status: 'running', cursor: '2026-09-11', failures: 0 });
      expect(back.job().partial).toEqual(['2026-09-12…2026-09-20 without 番茄']);
      expect(back.job().holes).toEqual([]); // written: a later job would skip its days anyway
      expect(back.rowsOf('2026').some((r) => r[1] === '番茄')).toBe(false);
      expect(back.rowsOf('2026').some((r) => r[1] === '高麗菜')).toBe(true);
    });

    it('keeps failing a window a throttle holds, rather than write it thin', () => {
      // A throttle drops a whole batch, and at the same place in every burst.
      // Writing the window without a batch of crops would make that permanent.
      const many = new Set(Object.keys(FILLER).slice(0, 13));
      const back = backfill((root, roc) => (many.has(root) ? null : market(root, roc)));
      back.api.handleSheetBackfill({ months: '12' });
      for (let i = 0; i < back.api.SHEET_BACKFILL_MAX_FAILURES; i++) back.api.sheetBackfillStep();

      expect(back.job()).toMatchObject({ status: 'failed', cursor: '2026-09-20' });
      expect(back.tabs.size).toBe(0);
    });

    it('counts how MOA answered, not how often a link failed', () => {
      // Two links killed, then one odd empty answer, is not "the same answer
      // three times": the window is retried, not written off.
      let empty = false;
      const back = backfill((root, roc) => (empty ? [] : market(root, roc)));
      back.api.handleSheetBackfill({ months: '12' });
      back.setJob({ failures: 2 }); // two links the execution limit killed
      empty = true;
      back.api.sheetBackfillStep();

      expect(back.job().gaps).toEqual([]);
      expect(back.job().cursor).toBe('2026-09-20');
    });

    it('does not take probe rows in the context days for the window\'s own', () => {
      // MOA with nothing for the window's nine days but the three before it
      // would otherwise pass for nine days of nothing, silently stepped past.
      const hole = (root: string, roc: string): Row[] => (roc >= '115.09.12' ? [] : market(root, roc));
      const back = backfill(hole);
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.job()).toMatchObject({ cursor: '2026-09-20', verdict: { kind: 'empty', count: 1 } });
      expect(back.job().last_error).toContain('no 甘藍 rows');
    });

    it('waits for the lock to begin, and tries again in a minute when it cannot', () => {
      // Whether a link runs is decided under the lock, so two links cannot
      // both find the job free and write the same window twice.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.contendLock();

      back.api.sheetBackfillStep();
      expect(back.moa.requests).toHaveLength(0);
      expect(back.triggers.map((t) => t.kind)).toContain('after:60000');
    });

    it('lets MOA settle its answer however the links around it fail', () => {
      // A throttle first (a batch unanswered), then the same one crop refused:
      // the retries for MOA's answer are not charged to the failure budget, so
      // the throttle cannot stop the job one answer short of settling.
      let call = 0;
      const many = new Set(Object.keys(FILLER).slice(0, 13));
      const back = backfill((root, roc) => {
        if (root === '甘藍' && roc === '115.09.09') call += 1; // once per link
        if (call === 1 && many.has(root)) return null;
        return root === '番茄' ? null : market(root, roc);
      });
      back.api.handleSheetBackfill({ months: '12' });
      for (let i = 0; i < 4; i++) back.api.sheetBackfillStep();

      expect(back.job()).toMatchObject({ status: 'running', cursor: '2026-09-11', failures: 0 });
      expect(back.job().partial).toEqual(['2026-09-12…2026-09-20 without 番茄']);
    });

    it('recognises the same refused crops however each went unanswered', () => {
      // 大白菜 is cut short and then not answered whole on the first try, and
      // plainly not answered after: the same two crops refused all three
      // times, which must read as one answer.
      let link = 0;
      const back = backfill((root, roc) => {
        if (root === '甘藍' && roc === '115.09.09') link += 1;
        if (root === '番茄') return null;
        if (root === '包心白菜') {
          const last = back.moa.requests[back.moa.requests.length - 1];
          return link === 1 && last.from === '115.09.09' && last.to === '115.09.20' ? 'cut' : null;
        }
        return market(root, roc);
      });
      back.api.handleSheetBackfill({ months: '12' });
      for (let i = 0; i < 3; i++) back.api.sheetBackfillStep();

      expect(back.job().cursor).toBe('2026-09-11');
      expect(back.job().partial).toHaveLength(1);
    });

    it('writes nothing, and records nothing, once another link holds its lease', () => {
      // Its watchdog took over while it was still crawling — possible where
      // executions may outlive the watchdog's delay.
      let during = () => {};
      const back = backfill((root, roc) => (during(), market(root, roc)));
      back.api.handleSheetBackfill({ months: '12' });
      during = () => back.setJob({ link_id: 'the-watchdog', link_started_at: new Date().toISOString() });

      back.api.sheetBackfillStep();
      expect(back.tabs.size).toBe(0);
      expect(back.job()).toMatchObject({ link_id: 'the-watchdog', link_open: true, windows: 0 });
    });

    it('does not delete the link a resume queued while it was finishing', () => {
      // The resume revokes the lease, so the old link's finish cannot drop
      // the triggers — the resume's among them — or write "failed" back.
      let during = () => {};
      const back = backfill((root, roc) => (during(), market(root, roc)));
      back.api.handleSheetBackfill({ months: '12' });
      during = () => {
        during = () => {};
        back.setJob({ status: 'failed' });
        back.api.handleSheetBackfill({ months: '12' });
      };

      back.api.sheetBackfillStep();
      expect(back.job()).toMatchObject({ status: 'running', link_id: null });
      expect(back.links()).toBeGreaterThan(0);
      expect(back.tabs.size).toBe(0); // and its crawl was not written either
    });

    it('replaces its own spent trigger when the lock is busy', () => {
      // Counting spent triggers as pending would stop the chain after two
      // busy firings; deleted by its id, the chain always has one link queued.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.contendLock();
      for (let i = 0; i < 5; i++) {
        const [mine] = back.triggers.filter((t) => t.handler === back.api.SHEET_BACKFILL_FN);
        back.api.sheetBackfillStep({ triggerUid: back.uidOf(mine) });
        expect(back.links()).toBe(1);
      }
    });

    it('keeps a day it let through but wrote nothing for as a hole', () => {
      // Every root truncated on 09-15 alone, so every crop is left out of it
      // and withheld from 09-16, which then has nothing to write.
      const heavy = (root: string, roc: string): Row[] => {
        const rows = market(root, roc);
        if (roc !== '115.09.15') return rows;
        return rows.flatMap((r) => Array.from({ length: 6 }, (_, i) => ({ ...r, MarketName: `市場${i}` })));
      };
      const back = backfill(heavy, { cap: 5 });
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.datesOf('2026')).not.toContain('2026-09-16');
      expect(back.job().holes).toContainEqual({ from: '2026-09-15', to: '2026-09-16' });
      expect(back.job().rejected.join('\n')).toContain('2026-09-16: every item withheld');
    });

    it('freezes a tab once, not on every append under the lock', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      for (let i = 0; i < 20 && back.job().status === 'running'; i++) back.api.sheetBackfillStep();
      expect(back.job().windows).toBe(4);
      expect(back.freezes.filter((t) => t === '2026').length).toBeLessThanOrEqual(2);
    });

    it('freezes the header of a tab the live path made before it did', () => {
      const back = backfill();
      back.tabs.set('2026', { rows: [[...back.api.SHEET_HEADER]], maxRows: 1000, textColumnA: true });
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();
      expect(back.tabs.get('2026')?.frozen).toBe(1);
    });

    it('ends a job whose spreadsheet changed under it', () => {
      // Its cursor, coverage and cached dates are about the one it started on.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.props.set(back.api.HISTORY_SHEET_ID_PROP, 'another-sheet');

      back.api.sheetBackfillStep();
      expect(back.moa.requests).toHaveLength(0);
      expect(back.job().status).toBe('failed');
      expect(back.job().last_error).toContain('HISTORY_SHEET_ID changed');
      expect(back.links()).toBe(0);
    });

    it('can still be cancelled once the sheet id is cleared', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.props.delete(back.api.HISTORY_SHEET_ID_PROP);

      expect(back.api.handleSheetBackfill({ cancel: '1' }).message).toBe('已停止回填');
      expect(back.links()).toBe(0);
    });

    it('leaves the triggers alone when it cannot read the job back', () => {
      // Unknowable whose job is stored; the watchdog retries past the limit.
      let during = () => {};
      const back = backfill((root, roc) => (during(), market(root, roc)));
      back.api.handleSheetBackfill({ months: '12' });
      during = () => back.breakRead(back.api.SHEET_BACKFILL_PROP);

      back.api.sheetBackfillStep();
      expect(back.triggers.filter((t) => t.handler === back.api.SHEET_BACKFILL_FN).map((t) => t.kind))
        .toEqual(['after:480000']);
    });

    it('judges the day after a deferred day against it', () => {
      // Deferred is not unjudged: the deferred day is still the one the next
      // is measured against, so a board-wide shift on that next day is seen.
      const shut = new Set(['115.09.06', '115.09.07', '115.09.08', '115.09.09', '115.09.10', '115.09.11', '115.09.12']);
      const world = (root: string, roc: string): Row[] => {
        if (shut.has(roc)) return root === '甘藍' ? [trendRow(roc, '休市', 0, 0)] : [];
        const rows = market(root, roc);
        return roc === '115.09.15' ? rows.map((r) => ({ ...r, Avg_Price: r.Avg_Price * 3 })) : rows;
      };
      const back = backfill(world);
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.job().cursor).toBe('2026-09-14'); // 09-14 deferred…
      expect(back.datesOf('2026')).not.toContain('2026-09-15'); // …and 09-15 judged against it
      expect(back.job().rejected[0]).toMatch(/^2026-09-15: .*median price ratio 3/);
    });

    it('refuses a broken stretch, which cannot vouch for itself', () => {
      // Two days wrong the same way agree with each other; against the median
      // of the rest of the span, both are outvoted.
      const x3 = (root: string, roc: string): Row[] =>
        roc === '115.09.16' || roc === '115.09.17'
          ? market(root, roc).map((r) => (r.CropName === '休市' ? r : { ...r, Avg_Price: r.Avg_Price * 3 }))
          : market(root, roc);
      const back = backfill(x3);
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.datesOf('2026')).not.toContain('2026-09-16');
      expect(back.datesOf('2026')).not.toContain('2026-09-17');
      expect(back.job().days_rejected).toBe(2);
    });

    it('judges the newest day of a window like any other', () => {
      // It has no day after it in the fetch; a good newest day beside a broken
      // one must not be refused for that, window after window.
      const x3 = (root: string, roc: string): Row[] =>
        roc === '115.09.19' ? market(root, roc).map((r) => ({ ...r, Avg_Price: r.Avg_Price * 3 })) : market(root, roc);
      const back = backfill(x3);
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.datesOf('2026')).toContain('2026-09-20');
      expect(back.datesOf('2026')).not.toContain('2026-09-19');
    });

    it('fetches the full span even where the written window is clamped', () => {
      // At the reach's end the window is clamped; clamping its context too
      // would leave the first day after a long closure with nothing behind
      // it, deferred into the same clamp and written unjudged.
      const shut = new Set(['115.08.16', '115.08.17', '115.08.18', '115.08.19', '115.08.20']);
      const world = (root: string, roc: string): Row[] => {
        if (shut.has(roc)) return root === '甘藍' ? [trendRow(roc, '休市', 0, 0)] : [];
        if (root === '番茄' && roc === '115.08.15') return [trendRow(roc, '番茄-牛番茄', 10, 200000)];
        return market(root, roc);
      };
      const back = backfill(world);
      back.api.handleSheetBackfill({ months: '1' }); // reaches back to 08-21
      for (let i = 0; i < 20 && back.job().status === 'running'; i++) back.api.sheetBackfillStep();

      const on21 = back.rowsOf('2026').filter((r) => r[0] === '2026-08-21').map((r) => r[1]);
      expect(on21).toContain('高麗菜');
      expect(on21).not.toContain('番茄'); // judged against 08-15, and flagged
    });

    it('settles a window both short of crops and empty as one answer', () => {
      // Judged as two answers, each would reset the other's count for ever.
      const world = (root: string, roc: string): Row[] | null => {
        if (root === '番茄') return null;
        return roc >= '115.09.12' ? [] : market(root, roc);
      };
      const back = backfill(world);
      back.api.handleSheetBackfill({ months: '12' });
      for (let i = 0; i < 3; i++) back.api.sheetBackfillStep();

      expect(back.job()).toMatchObject({ status: 'running', cursor: '2026-09-11', gaps: ['2026-09-12…2026-09-20'] });
    });

    it('stops claiming coverage once it has more holes than it can keep', () => {
      // Forgetting a hole would lose its days for good; re-crawling costs quota.
      const thin = (root: string, roc: string): Row[] =>
        roc === '115.09.17' && root !== '甘藍' && root !== '番茄' ? [] : market(root, roc);
      const back = backfill(thin);
      back.api.handleSheetBackfill({ months: '1' });
      // Forty separate single-day holes, a day apart, from an earlier stretch.
      const day = (i: number) =>
        `2024-${String(Math.floor(i / 10) + 1).padStart(2, '0')}-${String((i % 10) * 2 + 1).padStart(2, '0')}`;
      back.setJob({ holes: Array.from({ length: 40 }, (_, i) => ({ from: day(i), to: day(i) })) });
      back.api.sheetBackfillStep(); // refuses 09-17: the 41st hole

      expect(back.job().holes_overflow).toBe(true);
      back.api.handleSheetBackfill({ cancel: '1' });
      back.api.handleSheetBackfill({ months: '1' });
      expect(back.job().skip).toEqual([]);
    });

    it('judges a day against what a typical day of the span carries', () => {
      // One day with far more crops than the rest must not make the rest look
      // thin: rule (a) is "60 % of the reference", and a reference of every
      // crop seen on any day is a board no single day has.
      const sparse = new Set(Object.keys(FILLER).slice(0, 44));
      const world = (root: string, roc: string): Row[] =>
        sparse.has(root) && roc !== '115.09.09' ? [] : market(root, roc);
      const back = backfill(world);
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.job().days_rejected).toBe(0);
      expect(back.datesOf('2026')).toContain('2026-09-12');
    });

    it('does not let a broken context day refuse the good days after it', () => {
      // The day before a window is judged against nothing in this fetch. As
      // the only reference it would refuse every day after it; judged against
      // both neighbours, the good days agree with each other.
      const shifted = (root: string, roc: string): Row[] =>
        roc === '115.09.11' ? market(root, roc).map((r) => ({ ...r, Avg_Price: r.Avg_Price * 3 })) : market(root, roc);
      const back = backfill(shifted);
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.datesOf('2026')).toContain('2026-09-12');
      expect(back.job()).toMatchObject({ days_written: 8, days_rejected: 0 });
    });

    it('leaves what it moved past unwritten out of the coverage a later job skips', () => {
      // A refused day, a gap, a window written without a crop: marked covered,
      // no later job would ever look at them again.
      const thin = (root: string, roc: string): Row[] =>
        roc === '115.09.17' && root !== '甘藍' && root !== '番茄' ? [] : market(root, roc);
      const back = backfill(thin);
      back.api.handleSheetBackfill({ months: '1' });
      for (let i = 0; i < 20 && back.job().status === 'running'; i++) back.api.sheetBackfillStep();
      expect(back.job().holes).toEqual([{ from: '2026-09-17', to: '2026-09-17' }]);

      back.api.handleSheetBackfill({ months: '1' });
      expect(back.job().skip).toEqual([
        { from: '2026-08-21', to: '2026-09-16' },
        { from: '2026-09-18', to: '2026-09-20' },
      ]);
    });

    it('records a partial window once, however often its write is retried', () => {
      const back = backfill((root, roc) => (root === '番茄' ? null : market(root, roc)));
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();
      back.api.sheetBackfillStep();
      back.failWriteOnce('2026'); // settles on the third try, then fails to write
      back.api.sheetBackfillStep();
      expect(back.job().partial).toEqual([]);

      back.api.sheetBackfillStep();
      expect(back.job().partial).toEqual(['2026-09-12…2026-09-20 without 番茄']);
    });

    it('writes no day the guard would have refused', () => {
      // "The day the board would have shown": a day of a handful of items is
      // a crawl that failed on the live path, and the board keeps yesterday's.
      const thin = (root: string, roc: string): Row[] => {
        if (roc === '115.09.17' && root !== '甘藍' && root !== '番茄') return [];
        return market(root, roc);
      };
      const back = backfill(thin);
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.datesOf('2026')).not.toContain('2026-09-17');
      expect(back.datesOf('2026')).toContain('2026-09-18'); // judged against 09-16, the last day let through
      expect(back.job()).toMatchObject({ days_written: 7, days_rejected: 1 });
      expect(back.job().rejected[0]).toMatch(/^2026-09-17: count 2 < floor/);
    });

    it('refuses a day the rest of the span disagrees with', () => {
      // A whole board moving ×3 overnight is a unit change, not a market —
      // and only a day judged against another can see that.
      const shifted = (root: string, roc: string): Row[] =>
        roc === '115.09.17'
          ? market(root, roc).map((r) => (r.CropName === '休市' ? r : { ...r, Avg_Price: r.Avg_Price * 3 }))
          : market(root, roc);
      const back = backfill(shifted);
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.datesOf('2026')).not.toContain('2026-09-17');
      expect(back.job().rejected[0]).toMatch(/^2026-09-17: .*median price ratio 3/);
      expect(back.datesOf('2026')).toContain('2026-09-18'); // against 09-16, which it matches
    });

    it('steps past a window MOA keeps answering with nothing, on record', () => {
      // An empty body fails as unanswered; an ANSWER with no probe rows at all,
      // after every retry, is a hole in MOA's own data. Failing on it for ever
      // would leave everything older than it unreachable.
      const back = backfill(() => []);
      back.api.handleSheetBackfill({ months: '12' });
      for (let i = 0; i < back.api.SHEET_BACKFILL_MAX_FAILURES; i++) back.api.sheetBackfillStep();

      expect(back.job()).toMatchObject({ status: 'running', cursor: '2026-09-11', windows: 1, failures: 0 });
      expect(back.job().gaps).toEqual(['2026-09-12…2026-09-20']);
      expect(back.api.handleDiag().sheet_history.backfill.gaps).toBe(1);
    });

    it('withholds a crop the day after a day it was left out of', () => {
      // A root that truncates on one day alone is left out of it, and the next
      // day has nothing to judge that crop against.
      const heavy = (root: string, roc: string): Row[] => {
        if (root === '番茄' && roc === '115.09.15') {
          return Array.from({ length: 6 }, (_, i) => trendRow(roc, '番茄-牛番茄', 40, 2000, `市場${i}`));
        }
        return market(root, roc);
      };
      const back = backfill(heavy, { cap: 5 });
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      const itemsOn = (date: string) => back.rowsOf('2026').filter((r) => r[0] === date).map((r) => r[1]);
      expect(itemsOn('2026-09-15')).not.toContain('番茄'); // left out…
      expect(back.job().partial).toContain('2026-09-15 without 番茄'); // …on record
      expect(itemsOn('2026-09-16')).not.toContain('番茄'); // unjudged, so withheld
      expect(itemsOn('2026-09-16')).toContain('高麗菜');
      expect(itemsOn('2026-09-17')).toContain('番茄');
    });

    const noDayTwice = (back: ReturnType<typeof backfill>, except: string[] = []) => {
      for (const year of ['2025', '2026']) {
        for (const date of back.datesOf(year)) {
          if (except.includes(date)) continue;
          expect(back.rowsOf(year).filter((r) => r[0] === date)).toHaveLength(ROWS_A_DAY);
        }
      }
    };

    it('never writes a day twice after an append that failed part-way', () => {
      // A window across New Year appends to two tabs. The first lands, the
      // second throws: the retry must read the Sheet, not a cached set that
      // still says the first tab's days are missing.
      const back = backfill(market, { boardRoc: '115.01.05' });
      back.api.appendDailyHistory({
        type: 'board', date: '2026-01-05', roc_date: '115.01.05', generated_at: new Date().toISOString(),
        items: [{ name: '高麗菜', official_name: '甘藍', avg_price: 22, trade_volume: 90000, markets_count: 5 }],
      }); // the live day: the 2026 tab exists, so the failure lands on the data
      back.api.handleSheetBackfill({ months: '12' });
      back.failWriteOnce('2026');
      back.api.sheetBackfillStep();
      expect(back.job().failures).toBe(1);
      expect(back.datesOf('2025').length).toBeGreaterThan(0); // the first tab did land

      back.api.sheetBackfillStep();
      noDayTwice(back, ['2026-01-05']);
      expect(back.datesOf('2026')).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
    });

    it('finishes a year tab whose creation failed half-way', () => {
      // `insertSheet` landed and the header write did not: the tab exists,
      // empty, without its header or its text column.
      const back = backfill(market, { boardRoc: '115.01.05' });
      back.api.handleSheetBackfill({ months: '12' });
      back.failWriteOnce('2026');
      back.api.sheetBackfillStep();
      back.api.sheetBackfillStep();

      expect(back.tabs.get('2026')?.rows[0]).toEqual(back.api.SHEET_HEADER);
      expect(back.tabs.get('2026')?.textColumnA).toBe(true);
      noDayTwice(back);
      expect(back.datesOf('2026')).toHaveLength(4);
    });

    it('leaves the watchdog when it cannot record the link', () => {
      // The stored job would still read as a link in flight, and a next link
      // queued now would take itself for a duplicate and stop the chain.
      let during = () => {};
      const back = backfill((root, roc) => (during(), market(root, roc)));
      back.api.handleSheetBackfill({ months: '12' });
      during = () => back.breakProp(back.api.SHEET_BACKFILL_PROP);

      back.api.sheetBackfillStep();
      expect(back.triggers.filter((t) => t.handler === back.api.SHEET_BACKFILL_FN).map((t) => t.kind))
        .toEqual(['after:480000']);
    });

    it('counts a link before it does the work', () => {
      let failuresDuring = -1;
      const back = backfill((root, roc) => {
        if (failuresDuring < 0) failuresDuring = back.job().failures;
        return market(root, roc);
      });
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(failuresDuring).toBe(1); // what a killed link would leave behind
      expect(back.job().failures).toBe(0); // cleared by the window succeeding
    });

    it('waits longer before each retry of a failed window', () => {
      // A per-IP throttle lasts minutes; retrying after a second would spend
      // every retry inside it and stop the job over something that clears.
      const back = backfill(() => []);
      back.api.handleSheetBackfill({ months: '12' });
      const waits = () => back.triggers.filter((t) => t.handler === back.api.SHEET_BACKFILL_FN).map((t) => t.kind);

      back.api.sheetBackfillStep();
      expect(waits()).toEqual(['after:180000']);
      back.api.sheetBackfillStep();
      expect(waits()).toEqual(['after:360000']);
    });

    it('queues the next window at once after one that worked', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();
      expect(back.triggers.filter((t) => t.handler === back.api.SHEET_BACKFILL_FN).map((t) => t.kind))
        .toEqual(['after:1000']);
    });

    it('tries the lock once more rather than throw a crawl away', () => {
      // The live refresh holds it across its own Sheets round trip.
      let waits = 0;
      const lock = {
        getScriptLock: () => ({
          waitLock: () => {
            waits += 1;
            // 1 is the request, 2 the link's begin, 3 its write's first try.
            if (waits === 3) throw new Error('Could not obtain lock');
          },
          tryLock: () => true,
          releaseLock: () => {},
        }),
      };
      const back = backfill(market, { overrides: { LockService: lock } });
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.rowsOf('2026')).toHaveLength(8 * ROWS_A_DAY);
      expect(back.job().failures).toBe(0);
      expect(back.logs.some((l) => l.includes('retrying once'))).toBe(true);
    });

    it('fails the window when MOA does not answer a root, and writes nothing', () => {
      // A day is skipped by date ever after it is written, so writing the
      // window without the crop would make the hole permanent.
      const back = backfill((root, roc) => (root === '番茄' ? null : market(root, roc)));
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      expect(back.tabs.size).toBe(0);
      expect(back.job()).toMatchObject({ status: 'running', cursor: '2026-09-20' });
      expect(back.job().last_error).toContain('番茄');
    });

    it('defers a first day whose previous trading day is out of reach', () => {
      // A closure longer than the context days: the first day after it has no
      // previous trading day in the window, and would go in unjudged. The
      // next window ends on it instead, with its own days behind it.
      const shut = new Set(['115.09.06', '115.09.07', '115.09.08', '115.09.09', '115.09.10', '115.09.11', '115.09.12']);
      const holiday = (root: string, roc: string): Row[] => {
        if (shut.has(roc)) return root === '甘藍' ? [trendRow(roc, '休市', 0, 0)] : [];
        if (root === '番茄' && roc === '115.09.05') return [trendRow(roc, '番茄-牛番茄', 10, 200000)];
        return market(root, roc); // 09-14 onwards; 09-13 is in CLOSED
      };
      const back = backfill(holiday);
      back.api.handleSheetBackfill({ months: '12' });

      back.api.sheetBackfillStep();
      expect(back.datesOf('2026')[0]).toBe('2026-09-15'); // 09-14 held back
      expect(back.job().cursor).toBe('2026-09-14');

      back.api.sheetBackfillStep();
      const on14 = back.rowsOf('2026').filter((r) => r[0] === '2026-09-14').map((r) => r[1]);
      expect(on14).toContain('高麗菜');
      expect(on14).not.toContain('番茄'); // judged against 09-05, and flagged
    });

    it('drops its result when the job is cancelled while it runs', () => {
      let during = () => {};
      const back = backfill((root, roc) => (during(), market(root, roc)));
      back.api.handleSheetBackfill({ months: '12' });
      during = () => {
        if (back.job().status === 'running') back.api.handleSheetBackfill({ cancel: '1' });
      };

      back.api.sheetBackfillStep();
      expect(back.job()).toMatchObject({ status: 'cancelled', cursor: '2026-09-20', windows: 0 });
      expect(back.links()).toBe(0);
    });

    it('keeps a cancel over a window that just finished the job', () => {
      let during = () => {};
      const back = backfill((root, roc) => (during(), market(root, roc)));
      back.api.handleSheetBackfill({ months: '1' });
      for (let i = 0; i < 3; i++) back.api.sheetBackfillStep(); // one window left
      during = () => {
        if (back.job().status === 'running') back.api.handleSheetBackfill({ cancel: '1' });
      };

      back.api.sheetBackfillStep();
      expect(back.job().status).toBe('cancelled');
      expect(back.links()).toBe(0);
    });

    it('keeps a cancel the chain wrote "running" back over', () => {
      // The chain rewrites the job as it goes; a cancel landing between its
      // read and its write would be overwritten. The cancel's own property is
      // the one nothing else writes.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.api.handleSheetBackfill({ cancel: '1' });
      back.setJob({ status: 'running' }); // the lost write

      back.api.sheetBackfillStep();
      expect(back.moa.requests).toHaveLength(0);
      expect(back.job().status).toBe('cancelled');
      expect(back.links()).toBe(0);
    });

    it('leaves the link of a job that replaced it while it ran', () => {
      // Every link has the same handler name, so dropping "ours" by name would
      // drop the new job's too, and it would never start.
      let during = () => {};
      const back = backfill((root, roc) => (during(), market(root, roc)));
      back.api.handleSheetBackfill({ months: '12' });
      during = () => {
        if (back.job().id === 'replacement') return;
        back.setJob({ id: 'replacement', status: 'running' });
        back.triggers.push({ handler: back.api.SHEET_BACKFILL_FN, kind: 'after:1000' });
      };

      back.api.sheetBackfillStep();
      expect(back.job()).toMatchObject({ id: 'replacement', windows: 0 });
      expect(back.links()).toBeGreaterThan(0);
    });
  });

  describe('a whole job', () => {
    const runOut = (back: ReturnType<typeof backfill>) => {
      for (let i = 0; i < 20 && back.job().status === 'running'; i++) back.api.sheetBackfillStep();
    };

    it('walks back to its reach, writes every trading day once, and stops', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      runOut(back);

      expect(back.job()).toMatchObject({ status: 'done', from: '2026-08-21', windows: 4 });
      expect(back.links()).toBe(0);
      const dates = back.datesOf('2026');
      expect(dates[0]).toBe('2026-08-21');
      expect(dates[dates.length - 1]).toBe('2026-09-20');
      expect(dates).toHaveLength(31 - 1); // 08-21 … 09-20, less the closed day
      for (const date of dates) {
        expect(back.rowsOf('2026').filter((r) => r[0] === date)).toHaveLength(ROWS_A_DAY);
      }
    });

    it('does not crawl again what the previous job finished', () => {
      // Every day in it is written, and re-crawling a year to learn that would
      // spend most of a day's trigger runtime on nothing.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      runOut(back);
      const before = back.rowsOf('2026').length;
      const crawled = back.moa.requests.length;

      back.api.handleSheetBackfill({ months: '1' });
      expect(back.job().skip).toEqual([{ from: '2026-08-21', to: '2026-09-20' }]);
      runOut(back);
      expect(back.moa.requests).toHaveLength(crawled);
      expect(back.rowsOf('2026')).toHaveLength(before);
      expect(back.job()).toMatchObject({ status: 'done', windows: 0, days_written: 0 });
    });

    it('extends a finished reach by crawling only the new part', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      runOut(back);
      const crawled = back.moa.requests.length;

      back.api.handleSheetBackfill({ months: '2' });
      runOut(back);
      const again = back.moa.requests.slice(crawled);
      expect(again.length).toBeGreaterThan(0);
      // Nothing it fetched reaches into the finished month, context days aside.
      for (const r of again) expect(r.to < '115.08.21').toBe(true);
      expect(back.datesOf('2026')[0]).toBe('2026-07-21');
      expect(back.job()).toMatchObject({ status: 'done', days_skipped: 0 });
    });

    it('does not resume a job onto a different spreadsheet', () => {
      // Its cursor says where it got to in the OLD one.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();
      back.setJob({ status: 'failed' });
      const old = back.job();
      back.props.set(back.api.HISTORY_SHEET_ID_PROP, 'another-sheet');

      back.api.handleSheetBackfill({ months: '12' });
      expect(back.job().id).not.toBe(old.id);
      expect(back.job()).toMatchObject({ cursor: '2026-09-20', sheet: 'another-sheet', skip: [] });
    });

    it('skips nothing on a different spreadsheet', () => {
      // Coverage is a fact about one Sheet; the old range was never written
      // to the new one.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      runOut(back);
      back.props.set(back.api.HISTORY_SHEET_ID_PROP, 'another-sheet');

      back.api.handleSheetBackfill({ months: '1' });
      expect(back.job()).toMatchObject({ skip: [], sheet: 'another-sheet' });
    });

    it('answers repeated status requests without reading the Sheet again', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      runOut(back);
      const first = back.api.handleSheetBackfill({}).archive;
      const reads = back.sheetReads.length;

      expect(back.api.handleSheetBackfill({}).archive).toEqual(first);
      expect(back.sheetReads).toHaveLength(reads);
      expect(first.as_of).toBeTruthy();
    });

    it('keeps coverage that does not meet, too', () => {
      // A finished year and a later cancelled window do not touch; losing
      // either would re-crawl it.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' }); // 08-21 … 09-20
      runOut(back);
      back.api.storeBoard({
        type: 'board', date: '2026-10-19', roc_date: '115.10.19',
        generated_at: new Date().toISOString(), count: 0, items: [],
      });
      back.api.handleSheetBackfill({ months: '1' });
      back.api.sheetBackfillStep(); // 10-10 … 10-18
      back.api.handleSheetBackfill({ cancel: '1' });

      back.api.handleSheetBackfill({ months: '2' });
      expect(back.job().skip).toEqual([
        { from: '2026-08-21', to: '2026-09-20' },
        { from: '2026-10-10', to: '2026-10-18' },
      ]);
    });

    it('rewrites a corrected live day without reading the whole tab', () => {
      // The correction path reads under the history lock, and a backfilled
      // year is ~50k rows: column A to find the day, then the day alone.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      runOut(back);
      const live = (hoursAgo: number, price: number) => ({
        type: 'board', date: '2026-09-21', roc_date: '115.09.21',
        generated_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
        items: [{ name: '高麗菜', official_name: '甘藍', avg_price: price, trade_volume: 90000, markets_count: 5 }],
      });
      back.api.appendDailyHistory(live(8, 22));
      const tabRows = back.tabs.get('2026')?.rows.length ?? 0;
      back.cellsRead.count = 0;

      expect(back.api.appendDailyHistory(live(0, 23))).toBe('replaced');
      expect(back.cellsRead.count).toBeLessThan(tabRows + 8 * 2);
    });

    it('carries coverage across jobs, not only from the last one', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' }); // A: 08-21 … 09-20
      runOut(back);
      back.api.storeBoard({
        type: 'board', date: '2026-09-26', roc_date: '115.09.26',
        generated_at: new Date().toISOString(), count: 0, items: [],
      });
      back.api.handleSheetBackfill({ months: '1' }); // B: 08-26 … 09-25, skipping A
      runOut(back);
      const crawled = back.moa.requests.length;

      back.api.handleSheetBackfill({ months: '2' }); // C: 07-26 … 09-25
      expect(back.job().skip).toEqual([{ from: '2026-08-21', to: '2026-09-25' }]);
      runOut(back);
      for (const r of back.moa.requests.slice(crawled)) expect(r.to < '115.08.21').toBe(true);
    });

    it('reads a year\'s dates once a job, not once a link', () => {
      // A year's column is ~50k cells and a job ~40 links.
      const back = backfill();
      back.api.appendDailyHistory({
        type: 'board', date: '2026-09-18', roc_date: '115.09.18', generated_at: new Date().toISOString(),
        items: [{ name: '高麗菜', official_name: '甘藍', avg_price: 22, trade_volume: 90000, markets_count: 5 }],
      }); // the tab exists, with a day in it, before the job starts
      back.api.handleSheetBackfill({ months: '1' });
      runOut(back);
      expect(back.job()).toMatchObject({ windows: 4, days_skipped: 1 });
      expect(back.sheetReads.filter((t) => t === '2026')).toHaveLength(1);
    });

    it('neither cancels nor resumes on a cancel it cannot read', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.setJob({ status: 'failed' });
      expect(back.api.handleSheetBackfill({ months: '12', cancel: 'true' }).message).toBe('cancel 參數只接受 1');
      expect(back.job().status).toBe('failed');
    });

    it('does not pile up spare links while the lock stays busy', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      back.contendLock();
      for (let i = 0; i < 6; i++) back.api.sheetBackfillStep();
      expect(back.links()).toBeLessThanOrEqual(3);
    });

    it('lets cancel=1 through whatever else the request carries', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '12' });
      expect(back.api.handleSheetBackfill({ months: '0', cancel: '1' }).message).toBe('已停止回填');
    });

    it('does not count a blank cell as a day', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      runOut(back);
      back.tabs.get('2026')?.rows.push(['', '', '', '', '', '', '', '']);
      back.tabs.get('2026')?.rows.push([...back.api.SHEET_HEADER]); // a header a hand sort moved

      back.cache.delete('veggie_sheet_summary');
      expect(back.api.handleSheetBackfill({}).archive).toMatchObject({
        rows: 30 * ROWS_A_DAY, days: 30, first_date: '2026-08-21', last_date: '2026-09-20',
      });
    });

    it('does not guess at a day whose rows are not one block', () => {
      // A tab sorted by another column scatters a day; deleting "the block"
      // would delete other days' rows.
      const back = backfill();
      const live = (hoursAgo: number, price: number) => ({
        type: 'board', date: '2026-09-21', roc_date: '115.09.21',
        generated_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
        items: [
          { name: '高麗菜', official_name: '甘藍', avg_price: price, trade_volume: 90000, markets_count: 5 },
          { name: '番茄', official_name: '番茄', avg_price: 40, trade_volume: 9000, markets_count: 3 },
        ],
      });
      back.api.appendDailyHistory(live(8, 22));
      const rows = back.tabs.get('2026')?.rows as unknown[][];
      rows.splice(2, 0, ['2026-09-19', '其他', '其他', '', 1, 1, 1, '']); // between the day's two rows
      const before = rows.map((r) => r.slice());

      expect(back.api.appendDailyHistory(live(0, 23))).toBe('scattered');
      expect(back.tabs.get('2026')?.rows).toEqual(before);
    });

    it('stops a window at the finished part when the board has moved on', () => {
      // Days later the new job's top overlaps the old job's range: its first
      // window must end its crawl where the finished range begins.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      runOut(back);
      back.api.storeBoard({
        type: 'board', date: '2026-09-26', roc_date: '115.09.26',
        generated_at: new Date().toISOString(), count: 0, items: [],
      });
      const crawled = back.moa.requests.length;

      back.api.handleSheetBackfill({ months: '1' });
      back.api.sheetBackfillStep();
      const cabbage = back.moa.requests.slice(crawled).filter((r) => r.root === '甘藍');
      // 09-21 … 09-25 written; the rest of the full 12-day span is context.
      expect(cabbage).toEqual([{ root: '甘藍', from: '115.09.14', to: '115.09.25' }]);
      expect(back.job()).toMatchObject({ days_written: 5, days_skipped: 0, cursor: '2026-09-20' });
    });

    it('resumes a cancelled job\'s remainder, not its finished part', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      back.api.sheetBackfillStep(); // 09-12 … 09-20
      back.api.handleSheetBackfill({ cancel: '1' });

      back.api.handleSheetBackfill({ months: '1' });
      expect(back.job().skip).toEqual([{ from: '2026-09-12', to: '2026-09-20' }]);
    });

    it('reports what the Sheet holds, behind the token', () => {
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      runOut(back);
      expect(back.api.handleSheetBackfill({}).archive).toMatchObject({
        rows: 30 * ROWS_A_DAY, days: 30, first_date: '2026-08-21', last_date: '2026-09-20',
      });
    });

    it('counts only the year tabs', () => {
      // A new spreadsheet comes with a default tab, and an owner may keep
      // notes in one; neither is the archive.
      const back = backfill();
      back.api.handleSheetBackfill({ months: '1' });
      runOut(back);
      back.tabs.set('工作表1', { rows: [['notes'], ['2026-01-01', 'x']], maxRows: 1000, textColumnA: true });

      expect(back.api.handleSheetBackfill({}).archive).toMatchObject({ rows: 30 * ROWS_A_DAY, first_date: '2026-08-21' });
    });

    it('publishes its progress in diag, and not its errors', () => {
      // `diag` is public; the last error is platform text and stays behind
      // the token with the rest of the job.
      const back = backfill(() => null);
      back.api.handleSheetBackfill({ months: '12' });
      back.api.sheetBackfillStep();

      const published = back.api.handleDiag().sheet_history.backfill;
      expect(published).toMatchObject({ status: 'running', cursor: '2026-09-20', failures: 1 });
      expect(published).not.toHaveProperty('last_error');
      expect(published).not.toHaveProperty('id');
      expect(back.api.handleSheetBackfill({}).job.last_error).toContain('甘藍');
    });
  });

  describe('fetchCompleteRows — what MOA cuts short', () => {
    const daysOf = (rows: Row[]) => [...new Set(rows.map((r) => r.TransDate))].sort();

    it('refetches a truncated window in halves until every piece is whole', () => {
      // MOA keeps the NEWEST rows, so a truncated range quietly loses its
      // oldest days — or worse, part of one, whose average is then wrong.
      const oneADay = (root: string, roc: string) => (root === '甘藍' ? [trendRow(roc, '甘藍-初秋', 20, 60000)] : []);
      const back = backfill(oneADay, { cap: 3 });
      const { rows, unanswered } = back.api.fetchCompleteRows(['甘藍'], '115.09.01', '115.09.04');

      expect(daysOf(rows['甘藍'])).toEqual(['115.09.01', '115.09.02', '115.09.03', '115.09.04']);
      expect(unanswered).toEqual([]);
      expect(back.moa.requests.map((r) => `${r.from}–${r.to}`)).toEqual([
        '115.09.01–115.09.04', '115.09.01–115.09.02', '115.09.03–115.09.04',
      ]);
    });

    it('leaves out a single day that is too big to fetch whole', () => {
      const heavy = (root: string, roc: string) => {
        if (root !== '甘藍') return [];
        const n = roc === '115.09.03' ? 4 : 1;
        return Array.from({ length: n }, (_, i) => trendRow(roc, '甘藍-初秋', 20, 60000, `市場${i}`));
      };
      const back = backfill(heavy, { cap: 3 });
      const { rows } = back.api.fetchCompleteRows(['甘藍'], '115.09.01', '115.09.04');

      expect(daysOf(rows['甘藍'])).toEqual(['115.09.01', '115.09.02', '115.09.04']);
      expect(back.logs.some((l) => l.includes('still truncates on 115.09.03'))).toBe(true);
    });

    it('reports a root MOA did not answer instead of returning it empty', () => {
      // A throttled request is an empty body, not an empty `Data`. Returned as
      // "no rows", the archive would write every day of the window without
      // the crop — and skip those dates for good on every later run.
      const back = backfill((root, roc) => (root === '番茄' ? null : market(root, roc)));
      const { rows, unanswered } = back.api.fetchCompleteRows(['甘藍', '番茄'], '115.09.01', '115.09.04');

      expect(unanswered).toEqual(['番茄']);
      expect(rows['甘藍'].length).toBeGreaterThan(0);
      expect(back.moa.requests.filter((r) => r.root === '番茄')).toHaveLength(2); // retried once first
    });

    it('never takes back an answer when the retry goes silent', () => {
      // Out-of-season roots answer "nothing traded" and are retried with the
      // rest of the misses; a throttled retry says nothing about them.
      const back = backfill((root, roc) => {
        if (root !== '番茄') return market(root, roc);
        return back.moa.requests.filter((r) => r.root === '番茄').length > 1 ? null : [];
      });
      const { rows, unanswered } = back.api.fetchCompleteRows(['甘藍', '番茄'], '115.09.01', '115.09.04');
      expect(unanswered).toEqual([]);
      expect(rows['番茄']).toEqual([]);
    });

    it('does not take an error object for "nothing traded"', () => {
      const back = backfill((root, roc) => (root === '番茄' ? 'error' : market(root, roc)));
      expect(back.api.fetchCompleteRows(['甘藍', '番茄'], '115.09.01', '115.09.04').unanswered).toEqual(['番茄']);
    });

    it('takes an OK without rows for "nothing traded"', () => {
      // How an empty answer is shaped is not on record; `RS: "OK"` is an
      // answer either way, and failing every window over it would stop a job.
      const back = backfill((root, roc) => (root === '番茄' ? 'bare' : market(root, roc)));
      const { rows, unanswered } = back.api.fetchCompleteRows(['甘藍', '番茄'], '115.09.01', '115.09.04');
      expect(unanswered).toEqual([]);
      expect(rows['番茄']).toEqual([]);
    });

    it('reports a split that MOA stopped answering part-way', () => {
      const oneADay = (root: string, roc: string) => {
        if (root !== '甘藍') return [];
        return roc === '115.09.04' && back.moa.requests.length > 1 ? null : [trendRow(roc, '甘藍-初秋', 20, 60000)];
      };
      const back = backfill(oneADay, { cap: 3 });
      const { rows, unanswered } = back.api.fetchCompleteRows(['甘藍'], '115.09.01', '115.09.04');
      expect(unanswered).toEqual(['甘藍']);
      // Not the cut first page either: a caller that ignores `unanswered` —
      // the rolling backfill — would average its partial oldest day.
      expect(rows['甘藍']).toEqual([]);
    });

    /** Two markets a day at 20 and 40, so a day cut in half averages wrong. */
    const twoMarkets = (root: string, roc: string) =>
      root === '甘藍'
        ? [trendRow(roc, '甘藍-初秋', 20, 60000), trendRow(roc, '甘藍-初秋', 40, 60000, '台中')]
        : [];

    it('leaves the trend\'s cut oldest point out, in one request', () => {
      // A cut response drops the OLDEST rows, and the sparkline's first point
      // would be the average of whichever market was left. On the public path
      // the budget is one request, so that point is left out, not made whole.
      const back = backfill(twoMarkets, { cap: 7 }); // 4 days × 2 rows, one over
      const { trend } = back.api.handleTrend({ cropName: '甘藍', days: '4' });
      expect(trend).toEqual([null, 30, 30, 30]);
      expect(back.moa.requests).toHaveLength(1);
    });

    it('shares a trend MOA did not answer for minutes, not an hour', () => {
      // An hour of "no trades" for every visitor over one throttled request is
      // too long; not caching it at all would have every visitor hit a
      // throttled MOA again from the same IP.
      const back = backfill(() => null);
      back.api.handleTrend({ cropName: '甘藍', days: '4' });
      const key = [...back.cache.keys()].find((k) => k.startsWith('veggie_trend_')) as string;
      expect(back.cacheTtls.get(key)).toBe(120);
    });

    it('asks MOA nothing for a blank trend term', () => {
      // A blank term matches every crop MOA has.
      const back = backfill();
      back.api.handleTrend({ cropName: ' ', days: '14' });
      expect(back.moa.requests).toHaveLength(0);
    });

    it('makes the rolling backfill\'s cut window whole with one more request', () => {
      // That seed crawls every window in one execution, so its refetching is
      // bounded; and no older window covers what MOA cut, so dropping it
      // would leave the baseline a hole until those days aged out.
      const back = backfill(twoMarkets, { cap: 23 }); // 12 days × 2 rows, one over
      back.api.backfillHistory();
      const series = back.api.readHistory().items['高麗菜'];
      expect(series).toHaveLength(24);
      for (const [, price] of series) expect(price).toBe(30);
      const cabbage = back.moa.requests.filter((r) => r.root === '甘藍');
      expect(cabbage).toHaveLength(4); // two windows, one patch each
    });

    it('costs nothing extra when nothing is cut', () => {
      const back = backfill();
      back.api.fetchCompleteRows(['甘藍'], '115.09.01', '115.09.04');
      expect(back.moa.requests).toHaveLength(1);
    });
  });
});

describe('same weeks last year (#22 §2)', () => {
  const SHEET_ID = '1AbCdEfGh_stub';
  const HEADER = ['date', 'item', 'root', 'variety', 'avg_price_kg', 'volume_kg', 'markets', 'share_percent'];

  /** ISO date `days` after the day one year before `roc`. */
  const yearAgo = (roc: string, days = 0): string => {
    const [y, m, d] = roc.split('.').map(Number);
    const at = new Date(Date.UTC(y + 1911 - 1, m - 1, d + days));
    return at.toISOString().slice(0, 10);
  };
  const blend = (date: string, item: string, price: number) => [date, item, item, '', price, 1000, 3, ''];
  const variety = (date: string, item: string, name: string, price: number) => [date, item, item, name, price, '', '', 50];

  /** A backend with an archive holding `rows`, split into year tabs. */
  const archived = (rows: unknown[][], responses: Record<string, Row[]> = {}) => {
    const back = loadBackend(responses);
    back.props.set(back.api.HISTORY_SHEET_ID_PROP, SHEET_ID);
    for (const r of rows) {
      const year = String(r[0]).slice(0, 4);
      if (!back.tabs.has(year)) back.tabs.set(year, { rows: [HEADER], maxRows: 100000, textColumnA: true });
      back.tabs.get(year)?.rows.push(r);
    }
    return back;
  };

  it('does nothing until a sheet is configured', () => {
    const back = loadBackend({ 甘藍: [row('甘藍-初秋', 20, 60000)] });
    expect(back.api.refreshYearAgo('115.09.21')).toBeNull();
    const cabbage = back.api.buildBoard().items.find((it: { name: string }) => it.name === '高麗菜');
    expect(cabbage).not.toHaveProperty('last_year_price');
    expect(back.openedIds).toEqual([]);
  });

  it('takes each item\'s median blend price over the week either side, a year back', () => {
    const roc = '115.09.21';
    const back = archived([
      blend(yearAgo(roc, -6), '高麗菜', 20),
      blend(yearAgo(roc, 0), '高麗菜', 30),
      blend(yearAgo(roc, 5), '高麗菜', 25),
      variety(yearAgo(roc, 0), '高麗菜', '初秋', 99), // a variety row, not the item
      blend(yearAgo(roc, -8), '高麗菜', 100), // outside the window
      blend(yearAgo(roc, 0), '番茄', 40), // two days: too few to say anything
      blend(yearAgo(roc, 1), '番茄', 42),
    ]);
    expect(back.api.refreshYearAgo(roc)).toEqual({ 高麗菜: 25 });
  });

  it('reads the Sheet after the board is stored, and the next build shows it', () => {
    // A slow Sheets read has no place before the board is stored: the first
    // refresh stores its board, then reads; the next build compares.
    const roc = rocDate(0);
    const back = archived(
      [0, 1, 2].map((d) => blend(yearAgo(roc, d), '高麗菜', 25)),
      plausibleRowsWith({ 甘藍: [row('甘藍-初秋', 30, 60000)] }),
    );
    const stored = () => JSON.parse(back.api.readDurableBoard() as string);
    let readBeforeStore = false;
    back.afterRead.hook = () => { if (!back.api.readDurableBoard()) readBeforeStore = true; };

    back.api.refreshBoardCache();
    expect(readBeforeStore).toBe(false);
    const first = stored().items.find((it: { name: string }) => it.name === '高麗菜');
    expect(first).not.toHaveProperty('last_year_price');

    back.api.refreshBoardCache();
    const cabbage = stored().items.find((it: { name: string }) => it.name === '高麗菜');
    expect(cabbage.last_year_price).toBe(15); // 25 元/公斤 × 0.6
    expect(cabbage.vs_last_year_percent).toBe(20); // 30 vs 25

    const result = BoardResponseSchema.safeParse(stored());
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it('does not apply medians kept for a window far from the board\'s date', () => {
    const back = archived([0, 1, 2].map((d) => blend(yearAgo('115.09.01', d), '高麗菜', 25)));
    back.api.refreshYearAgo('115.09.01');
    expect(back.api.keptYearAgo('115.09.05')).toEqual({ 高麗菜: 25 }); // a few days on: close enough
    expect(back.api.keptYearAgo('115.09.21')).toBeNull(); // three weeks on: another window
    back.props.set(back.api.HISTORY_SHEET_ID_PROP, 'another');
    expect(back.api.keptYearAgo('115.09.02')).toBeNull(); // another spreadsheet
  });

  it('reads again within the day while a backfill may be filling the window', () => {
    const roc = '115.09.21';
    const back = archived([0, 1, 2].map((d) => blend(yearAgo(roc, d), '高麗菜', 25)));
    back.props.set('veggie_sheet_backfill', JSON.stringify({ id: 'j', status: 'running' }));
    back.api.refreshYearAgo(roc);
    const age = (hours: number) => {
      const kept = JSON.parse(back.props.get(back.api.YOY_PROP) as string);
      kept.at = new Date(Date.now() - hours * 3_600_000).toISOString();
      back.props.set(back.api.YOY_PROP, JSON.stringify(kept));
    };
    const reads = back.sheetReads.length;
    age(7);
    back.api.refreshYearAgo(roc);
    expect(back.sheetReads.length).toBeGreaterThan(reads); // partial may have grown
  });

  it('reads again after a day even when the trading date has not moved', () => {
    // A long closure keeps one trading date for days.
    const roc = '115.09.21';
    const back = archived([0, 1, 2].map((d) => blend(yearAgo(roc, d), '高麗菜', 25)));
    back.api.refreshYearAgo(roc);
    const kept = JSON.parse(back.props.get(back.api.YOY_PROP) as string);
    const reads = back.sheetReads.length;

    kept.at = new Date(Date.now() - 7 * 3_600_000).toISOString();
    back.props.set(back.api.YOY_PROP, JSON.stringify(kept));
    back.api.refreshYearAgo(roc);
    expect(back.sheetReads).toHaveLength(reads); // no backfill running: good for a day

    kept.at = new Date(Date.now() - back.api.YOY_KEEP_MS - 60_000).toISOString();
    back.props.set(back.api.YOY_PROP, JSON.stringify(kept));
    back.api.refreshYearAgo(roc);
    expect(back.sheetReads.length).toBeGreaterThan(reads);
  });

  it('checks the dates again on the second read', () => {
    // A sort by hand between the two reads puts other days on the rows the
    // first read found.
    const roc = '115.09.21';
    const back = archived([
      blend(yearAgo(roc, 0), '高麗菜', 10),
      blend(yearAgo(roc, 1), '高麗菜', 20),
      blend(yearAgo(roc, 2), '高麗菜', 30),
      blend(yearAgo(roc, 3), '高麗菜', 40),
      blend(yearAgo(roc, 60), '高麗菜', 500),
    ]);
    let first = true;
    back.afterRead.hook = (tab) => {
      if (!first || tab !== '2025') return;
      first = false;
      const rows = back.tabs.get('2025')?.rows as unknown[][];
      [rows[1], rows[5]] = [rows[5], rows[1]]; // the out-of-window day moves into the run
    };
    // 20, 30, 40 — not 500, 20, 30, 40, whose median would be 35.
    expect(back.api.refreshYearAgo(roc)).toEqual({ 高麗菜: 30 });
  });

  it('weighs a day archived twice once', () => {
    const roc = '115.09.21';
    const back = archived([
      blend(yearAgo(roc, 0), '高麗菜', 10),
      blend(yearAgo(roc, 0), '高麗菜', 10),
      blend(yearAgo(roc, 0), '高麗菜', 10),
      blend(yearAgo(roc, 1), '高麗菜', 30),
      blend(yearAgo(roc, 2), '高麗菜', 40),
    ]);
    expect(back.api.refreshYearAgo(roc)).toEqual({ 高麗菜: 30 });
  });

  it('keeps the median unrounded, as the 28-day one is', () => {
    const roc = '115.09.21';
    const back = archived([0, 1, 2].map((d) => blend(yearAgo(roc, d), '高麗菜', 10.04)));
    expect(back.api.refreshYearAgo(roc)).toEqual({ 高麗菜: 10.04 });
  });

  it('measures the percentage against the median, not its rounding', () => {
    const items = [{ name: '高麗菜', avg_price: 10.04 }];
    loadBackend().api.applyYearOverYear(items, { 高麗菜: 10.04 });
    expect(items[0]).toMatchObject({ last_year_price: 6, vs_last_year_percent: 0 });
  });

  it('reads the Sheet once a trading day, not every refresh', () => {
    const roc = '115.09.21';
    const back = archived([0, 1, 2].map((d) => blend(yearAgo(roc, d), '高麗菜', 25)));
    back.api.refreshYearAgo(roc);
    const reads = back.sheetReads.length;

    expect(back.api.refreshYearAgo(roc)).toEqual({ 高麗菜: 25 });
    expect(back.sheetReads).toHaveLength(reads);
    back.api.refreshYearAgo('115.09.22'); // the next trading date asks again
    expect(back.sheetReads.length).toBeGreaterThan(reads);
  });

  it('asks again later when the archive did not reach back a year yet', () => {
    // The backfill may still be walking there.
    const roc = '115.09.21';
    const back = archived([]);
    back.tabs.set('2025', { rows: [HEADER, blend('2025-01-01', '高麗菜', 1)], maxRows: 1000, textColumnA: true });
    expect(back.api.refreshYearAgo(roc)).toEqual({});
    const reads = back.sheetReads.length;

    back.api.refreshYearAgo(roc);
    expect(back.sheetReads).toHaveLength(reads); // not every refresh…

    const kept = JSON.parse(back.props.get(back.api.YOY_PROP) as string);
    kept.at = new Date(Date.now() - back.api.YOY_EMPTY_RETRY_MS - 60_000).toISOString();
    back.props.set(back.api.YOY_PROP, JSON.stringify(kept));
    back.api.refreshYearAgo(roc);
    expect(back.sheetReads.length).toBeGreaterThan(reads); // …but not never
  });

  it('reads across New Year from both tabs', () => {
    const roc = '115.01.03'; // a year back is 2025-01-03: the window starts in 2024
    const back = archived([
      blend('2024-12-30', '高麗菜', 20),
      blend('2024-12-31', '高麗菜', 22),
      blend('2025-01-02', '高麗菜', 24),
    ]);
    expect(back.api.refreshYearAgo(roc)).toEqual({ 高麗菜: 22 });
  });

  it('finds the window\'s days wherever they sit, and reads only them', () => {
    // The backfill writes windows newest-first, so a week's days can be in
    // more than one run of rows, with other days between.
    const roc = '115.09.21';
    const filler = Array.from({ length: 300 }, (_, i) => blend(`2025-03-${String(i % 28 + 1).padStart(2, '0')}`, '番茄', 1));
    const back = archived([
      blend(yearAgo(roc, 3), '高麗菜', 30),
      ...filler.slice(0, 150),
      blend(yearAgo(roc, -3), '高麗菜', 10),
      blend(yearAgo(roc, -2), '高麗菜', 20),
      ...filler.slice(150),
    ]);
    back.cellsRead.count = 0;
    expect(back.api.refreshYearAgo(roc)).toEqual({ 高麗菜: 20 });
    expect(back.cellsRead.count).toBeLessThan(303 + 3 * 8 + 1); // column A, then the three rows
  });

  it('never costs the board anything when the Sheet cannot be read', () => {
    const back = archived([], plausibleRowsWith({}));
    back.breakSheet();
    expect(back.api.refreshBoardCache().count).toBeGreaterThan(0);
    expect(back.api.readDurableBoard()).toBeTruthy();
    expect(back.props.has(back.api.YOY_PROP)).toBe(false); // not kept: the next refresh asks again
  });

  it('asks again when pointed at another spreadsheet', () => {
    const roc = '115.09.21';
    const back = archived([0, 1, 2].map((d) => blend(yearAgo(roc, d), '高麗菜', 25)));
    back.api.refreshYearAgo(roc);
    const reads = back.sheetReads.length;
    back.props.set(back.api.HISTORY_SHEET_ID_PROP, 'another');
    back.api.refreshYearAgo(roc);
    expect(back.sheetReads.length).toBeGreaterThan(reads);
  });

  it('says in diag which trading date it compares and how many items it covers', () => {
    const roc = '115.09.21';
    const back = archived([0, 1, 2].map((d) => blend(yearAgo(roc, d), '高麗菜', 25)));
    back.api.refreshYearAgo(roc);
    expect(back.api.handleDiag().sheet_history.year_ago).toMatchObject({ date: roc, items: 1 });
  });

  it('leaves an item without a year-ago median as it was', () => {
    const items = [{ name: '高麗菜', avg_price: 30 }, { name: '番茄', avg_price: 40 }];
    loadBackend().api.applyYearOverYear(items, { 高麗菜: 25 });
    expect(items[1]).toEqual({ name: '番茄', avg_price: 40 });
  });
});

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
  const goodRows = plausibleRows();

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

  it('clears the refresh lock even when the trigger will not drop', () => {
    // Same shape as the backfill's cleanup: a `ScriptApp` failure used to
    // strand `REFRESH_LOCK_KEY` for its whole TTL, and that is the lock that
    // stops `?action=warm` queueing another rebuild.
    const { api, cache, breakTriggerDelete, logs } = loadBackend(plausibleRows());
    api.scheduleRefresh();
    expect(cache.get('veggie_refresh_queued')).toBe('1');
    breakTriggerDelete();

    expect(() => api.refreshBoardCacheOnce()).not.toThrow();
    expect(cache.has('veggie_refresh_queued')).toBe(false);
    expect(logs.some((l) => l.includes('trigger not dropped'))).toBe(true);
  });

  it('drops the refresh trigger before it frees its lock too', () => {
    const { api, cacheRemovals } = loadBackend(plausibleRows());
    api.scheduleRefresh();

    api.refreshBoardCacheOnce();

    const freed = cacheRemovals.find((r) => r.key === 'veggie_refresh_queued');
    expect(freed).toBeDefined();
    expect(freed?.triggers).not.toContain('refreshBoardCacheOnce');
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
/** `loadBackend` with one GAS service swapped out. */
const loadBackendWith = (overrides: Record<string, unknown>) => loadBackend({}, overrides);

describe('operator authentication — isAdmin', () => {
  it('fails closed while no ADMIN_TOKEN property is set', () => {
    const { api } = loadBackend();
    expect(api.isAdmin({ token: '' })).toBe(false);
    expect(api.isAdmin({ token: 'anything' })).toBe(false);
    expect(api.isAdmin({})).toBe(false);
    expect(api.isAdmin(undefined)).toBe(false);
  });

  it('accepts only the exact token', () => {
    const { api, props } = loadBackend();
    props.set(api.ADMIN_TOKEN_PROP, 's3cret-token');
    expect(api.isAdmin({ token: 's3cret-token' })).toBe(true);
    expect(api.isAdmin({ token: 's3cret-tokeN' })).toBe(false); // same length, one char off
    expect(api.isAdmin({ token: 's3cret' })).toBe(false);
    expect(api.isAdmin({ token: 's3cret-token-and-more' })).toBe(false);
    expect(api.isAdmin({})).toBe(false);
  });

  it('treats a properties outage as "not the operator"', () => {
    const { api, props } = loadBackend();
    props.set(api.ADMIN_TOKEN_PROP, 's3cret-token');
    const broken = { getScriptProperties: () => { throw new Error('properties unavailable'); } };
    // Rebuild the backend with a broken PropertiesService for this one check.
    const { api: brokenApi } = loadBackendWith({ PropertiesService: broken });
    expect(brokenApi.isAdmin({ token: 's3cret-token' })).toBe(false);
  });
});

describe('doGet — admin gate on operator actions', () => {
  const TOKEN = 'correct-horse-battery';
  const withToken = (extra: Record<string, string> = {}) => ({ token: TOKEN, ...extra });

  it('serves the board, search and trend to anyone', () => {
    const { get } = loadBackend({ 甘藍: [row('甘藍-初秋', 20, 60000)] });
    expect(get({}).type).toBe('board');
    expect(get({ action: 'search', query: '高麗菜' }).type).toBe('search');
    expect(get({ action: 'getTrend', cropName: '甘藍' }).cropName).toBe('甘藍');
  });

  it('refuses backfill without the token and creates no trigger', () => {
    const { get, triggers, props } = loadBackend();
    props.set('ADMIN_TOKEN', TOKEN);
    const res = get({ action: 'backfill', force: '1' });
    expect(res).toEqual({ type: 'backfill', error: 'unauthorized', message: '此操作需要 token 參數' });
    expect(triggers).toEqual([]);

    expect(get({ action: 'backfill', ...withToken() }).queued).toBe(true);
    expect(triggers.map((t) => t.handler)).toEqual(['backfillHistoryOnce']);
  });

  it('refuses backfill even with a token while no ADMIN_TOKEN is configured', () => {
    const { get, triggers } = loadBackend();
    expect(get({ action: 'backfill', token: TOKEN }).error).toBe('unauthorized');
    expect(triggers).toEqual([]);
  });

  it('refuses alerttest without the token and sends nothing', () => {
    const { get, mails, props } = loadBackend();
    props.set('ADMIN_TOKEN', TOKEN);
    expect(get({ action: 'alerttest' }).error).toBe('unauthorized');
    expect(mails).toHaveLength(0);

    expect(get({ action: 'alerttest', ...withToken() }).sent).toBe(true);
    expect(mails).toHaveLength(1);
  });

  it('keeps warm public but honours force only for the operator', () => {
    const { get, cache, props } = loadBackend();
    props.set('ADMIN_TOKEN', TOKEN);

    const first = get({ action: 'warm' });
    expect(first.queued).toBe(true); // anonymous warm still self-heals a stale board
    expect(first.forced).toBe(false);

    // Locked for 15 minutes now. Anonymous force must NOT jump it …
    const anon = get({ action: 'warm', force: '1' });
    expect(anon.queued).toBe(false);
    expect(anon.forced).toBe(false);
    expect(cache.has('veggie_refresh_queued')).toBe(true);

    // … the operator can.
    const admin = get({ action: 'warm', ...withToken({ force: '1' }) });
    expect(admin.queued).toBe(true);
    expect(admin.forced).toBe(true);
  });

  it('refusal writes nothing — no mail, no property, no trigger', () => {
    const { get, mails, props, triggers } = loadBackend();
    props.set('ADMIN_TOKEN', TOKEN);
    const before = new Map(props);
    get({ action: 'backfill' });
    get({ action: 'alerttest' });
    expect(mails).toHaveLength(0);
    expect(triggers).toEqual([]);
    expect(props).toEqual(before);
  });

  it('redacts the last failure reason on diag unless the caller is the operator', () => {
    const { get, props, api } = loadBackend();
    props.set('ADMIN_TOKEN', TOKEN);
    props.set('veggie_last_refresh_fail', '2026-09-01T02:00:00.000Z 近期查無交易資料');

    expect(get({ action: 'diag' }).last_refresh_fail).toBe('2026-09-01T02:00:00.000Z no_trade_dates');
    expect(get({ action: 'diag', ...withToken() }).last_refresh_fail).toBe('2026-09-01T02:00:00.000Z 近期查無交易資料');

    expect(api.redactFailure(null)).toBeNull();
    expect(api.redactFailure('2026-09-01T02:00:00.000Z empty board')).toBe('2026-09-01T02:00:00.000Z empty_board');
    expect(api.redactFailure('2026-09-01T02:00:00.000Z MOA said: 500 <html>…')).toBe('2026-09-01T02:00:00.000Z unknown');
  });
});

describe('alert recipient — nothing personal in the source', () => {
  it('reads the ALERT_EMAIL property', () => {
    const { api, props, mails } = loadBackend();
    props.set(api.ALERT_EMAIL_PROP, 'ops@example.org');
    expect(api.alertRecipient()).toBe('ops@example.org');
    api.handleAlertTest();
    expect(mails[0].to).toBe('ops@example.org');
    expect(api.handleDiag().alert.recipient_configured).toBe(true);
  });

  it('has no Session fallback — that scope is not in the manifest', () => {
    // `Session.getEffectiveUser()` needs userinfo.email; appsscript.json pins
    // an explicit scope list without it, and adding one forces re-consent.
    // The stubbed globals deliberately omit Session, so any use would throw.
    expect(SOURCE).not.toContain('Session.');
    const manifest = JSON.parse(readFileSync(resolve(BACKEND_DIR, 'appsscript.json'), 'utf8'));
    expect(manifest.oauthScopes).not.toContain('https://www.googleapis.com/auth/userinfo.email');
  });

  it('reports a category when no recipient is configured, and never breaks serving', () => {
    const { api, props, mails, logs } = loadBackend();
    props.delete(api.ALERT_EMAIL_PROP);
    expect(api.alertRecipient()).toBeNull();
    expect(api.handleDiag().alert.recipient_configured).toBe(false);

    const probe = api.handleAlertTest();
    expect(probe.sent).toBe(false);
    expect(probe.reason).toBe('no_recipient');
    expect(mails).toHaveLength(0);

    // The serving path's silence alert goes through the same resolver; a
    // missing recipient is logged and swallowed like any other mail failure.
    api.storeBoard({ type: 'board', roc_date: '115.08.01', generated_at: '2000-01-01T00:00:00.000Z', count: 1, items: [{ name: 'x' }] });
    expect(api.readBoard().type).toBe('board');
    expect(logs.some((l) => l.includes('no alert recipient'))).toBe(true);
  });

  it('keeps every e-mail address out of the backend source', () => {
    expect(SOURCE).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});

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

/**
 * The plausibility guard. The refresh used to store anything that was not
 * empty, so a throttled crawl (half the roots answering) or a MOA unit change
 * (every price ×1.67) overwrote a good board with a wrong one — and
 * `updateHistory` baked the wrong numbers into the 28-day baseline. The
 * thresholds ARE the feature, so every rule is pinned normal / exactly at the
 * boundary / past it.
 */
type GuardDef = { name: string; official: string; category: string; variety?: string };

/** The board definition, read once: the stubs below build their rows from it. */
const GUARD_DEFS: GuardDef[] = loadBackend().api.BOARD_ITEMS;

/**
 * A full trading day: one MOA row per board item, keyed by root, priced at
 * 20 元/公斤. The alerting suites above used to fake a healthy refresh with a
 * single 甘藍 row; the guard rejects a one-item board, so "healthy" now has to
 * look healthy. A hoisted `function` on purpose — those suites build their
 * fixture while the file is still being collected, before `const`s below run.
 */
function plausibleRows(): Record<string, Row[]> {
  const defs: GuardDef[] = loadBackend().api.BOARD_ITEMS;
  const byRoot: Record<string, Row[]> = {};
  for (const def of defs) {
    const rows = byRoot[def.official] ?? (byRoot[def.official] = []);
    rows.push(row(def.official + (def.variety ? `-${def.variety}` : ''), 20, 60000));
  }
  return byRoot;
}

/** `plausibleRows()` with some roots' rows replaced. */
function plausibleRowsWith(over: Record<string, Row[]>): Record<string, Row[]> {
  return { ...plausibleRows(), ...over };
}

/** One board item, carrying only the fields the guard reads. */
const guardItem = (
  name: string,
  cattyPrice: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  code: name, name, official_name: name, category: '葉菜類',
  avg_price: cattyPrice / 0.6, catty_price: cattyPrice, change_percent: 0,
  trade_volume: 60000, unit: '公斤', markets_count: 6, ...extra,
});

/** `count` items at one price — the flat board every rule below deviates from. */
const guardBoard = (count: number, cattyPrice = 10, roc = '115.09.02') => ({
  type: 'board',
  roc_date: roc,
  count,
  items: Array.from({ length: count }, (_, i) => guardItem(`品項${i}`, cattyPrice)),
});

describe('validateBoard', () => {
  /** 40 common items, `jumped` of them at `ratio` × the stored board's price. */
  const jumpedBoard = (jumped: number, ratio: number) => ({
    ...guardBoard(40),
    items: Array.from({ length: 40 }, (_, i) => guardItem(`品項${i}`, i < jumped ? 10 * ratio : 10)),
  });

  /** A 40-item board — enough to clear rule (a) — whose 品項0 carries `extra`. */
  const boardWithItem = (extra: Record<string, unknown>) => {
    const board = guardBoard(40);
    board.items[0] = guardItem('品項0', 10, extra);
    return board;
  };

  it('(a) accepts a board that only lost a few items to the season', () => {
    const { api } = loadBackend();
    expect(api.validateBoard(guardBoard(90), guardBoard(94)).ok).toBe(true);
  });

  it('(a) accepts exactly 60% of the stored board and rejects one item below', () => {
    const { api } = loadBackend();
    expect(api.validateBoard(guardBoard(60), guardBoard(100)).ok).toBe(true);
    expect(api.validateBoard(guardBoard(59), guardBoard(100)).reasons).toEqual([
      'count 59 < 60% of previous 100',
    ]);
  });

  it('(a) holds the absolute floor however small the stored board was', () => {
    const { api } = loadBackend();
    // 60% of 40 is 24, but a 29-item board is a failed crawl either way.
    expect(api.validateBoard(guardBoard(29), guardBoard(40)).reasons).toEqual(['count 29 < floor 30']);
    expect(api.validateBoard(guardBoard(30), guardBoard(40)).ok).toBe(true);
  });

  it('(b) rejects a fifth of the common items jumping beyond ×3', () => {
    const { api } = loadBackend();
    expect(api.validateBoard(jumpedBoard(7, 4), guardBoard(40)).ok).toBe(true); // 17.5%
    expect(api.validateBoard(jumpedBoard(8, 4), guardBoard(40)).reasons).toEqual([
      '8 of 40 common items moved by more than 200% (20%, limit 20%)',
    ]);
  });

  it('(b) treats exactly ×3 as a market move, not a unit change', () => {
    const { api } = loadBackend();
    expect(api.validateBoard(jumpedBoard(8, 3), guardBoard(40)).ok).toBe(true);
    expect(api.validateBoard(jumpedBoard(8, 1 / 3), guardBoard(40)).ok).toBe(true);
  });

  it('(c) rejects a median displacement of the whole board, either direction', () => {
    const { api } = loadBackend();
    expect(api.validateBoard(guardBoard(40, 20), guardBoard(40, 10)).ok).toBe(true); // exactly ×2
    expect(api.validateBoard(guardBoard(40, 5), guardBoard(40, 10)).ok).toBe(true); // exactly ÷2
    expect(api.validateBoard(guardBoard(40, 25), guardBoard(40, 10)).reasons).toEqual([
      'median price ratio 2.5 over 40 common items outside [0.5, 2]',
    ]);
    expect(api.validateBoard(guardBoard(40, 4), guardBoard(40, 10)).reasons).toEqual([
      'median price ratio 0.4 over 40 common items outside [0.5, 2]',
    ]);
  });

  it('(b, c) stay silent when the two boards share no item at all', () => {
    const { api } = loadBackend();
    const renamed = {
      ...guardBoard(40),
      items: Array.from({ length: 40 }, (_, i) => guardItem(`新品項${i}`, 100)),
    };
    expect(api.validateBoard(renamed, guardBoard(40, 10)).ok).toBe(true);
  });

  it('(d) rejects a trading date that went backwards', () => {
    const { api } = loadBackend();
    expect(api.validateBoard(guardBoard(40, 10, '115.09.01'), guardBoard(40, 10, '115.09.02')).reasons).toEqual([
      'trading date 115.09.01 is older than the stored 115.09.02',
    ]);
    // The same date is the normal case: the 4-hourly refresh revisits it.
    expect(api.validateBoard(guardBoard(40, 10, '115.09.02'), guardBoard(40, 10, '115.09.02')).ok).toBe(true);
    expect(api.validateBoard(guardBoard(40, 10, '115.09.03'), guardBoard(40, 10, '115.09.02')).ok).toBe(true);
  });

  it('reports every triggered rule, not just the first', () => {
    const { api } = loadBackend();
    const verdict = api.validateBoard(guardBoard(20, 40, '115.09.01'), guardBoard(40, 10, '115.09.02'));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toEqual([
      'count 20 < floor 30',
      '20 of 20 common items moved by more than 200% (100%, limit 20%)',
      'median price ratio 4 over 20 common items outside [0.5, 2]',
      'trading date 115.09.01 is older than the stored 115.09.02',
    ]);
  });

  it('applies only the absolute floor on first deploy', () => {
    const { api } = loadBackend();
    expect(api.validateBoard(guardBoard(api.BOARD_MIN_ITEMS), null).ok).toBe(true);
    expect(api.validateBoard(guardBoard(api.BOARD_MIN_ITEMS - 1), null).reasons).toEqual(['count 29 < floor 30']);
    // Nothing to compare against, so no relative rule can fire: a board that
    // would be rejected on price shift and on date order is published.
    expect(api.validateBoard(guardBoard(30, 500, '100.01.01'), null).ok).toBe(true);
  });

  it('shares its floor with the client contract, below the probe threshold', () => {
    // `board.schema.ts` publishes the same number so the external probe and
    // the UI reason about the guard without a second definition; the probe's
    // "worth a look" threshold must sit above the "certainly broken" floor,
    // or the probe could never alert on a board the guard still accepts.
    const { api } = loadBackend();
    expect(api.BOARD_MIN_ITEMS).toBe(BOARD_MIN_ITEMS);
    expect(BOARD_HEALTHY_ITEMS).toBeGreaterThan(api.BOARD_MIN_ITEMS);
  });

  it('(e) flags a huge move only when the volume collapsed with it', () => {
    const { api } = loadBackend();
    const prev = guardBoard(40);
    // Yesterday's 60 000 kg comes off the card, not off the stored board: the
    // stored board is the previous trading day only on the day's FIRST
    // refresh (#77).
    const suspects = (extra: Record<string, unknown>) =>
      api.validateBoard(boardWithItem({ prev_volume: 60000, ...extra }), prev).suspects;

    expect(suspects({ change_percent: 200, trade_volume: 60000 })).toEqual([]); // volume held: a real move
    expect(suspects({ change_percent: 200, trade_volume: 12000 })).toEqual([]); // exactly 20% of yesterday
    expect(suspects({ change_percent: 150, trade_volume: 100 })).toEqual([]); // exactly at the change threshold
    expect(suspects({ change_percent: 151, trade_volume: 11999 })).toEqual(['品項0']);
    expect(suspects({ change_percent: -400, trade_volume: 100 })).toEqual(['品項0']); // a collapse counts too
  });

  it('(e) leaves a newly listed item alone — there is no volume to compare', () => {
    const { api } = loadBackend();
    const board = guardBoard(40);
    // No `prev_volume`: the crop did not trade yesterday, so the rule has
    // nothing to say about today's move.
    board.items[0] = guardItem('新上架', 10, { change_percent: 400, trade_volume: 100 });
    expect(api.validateBoard(board, guardBoard(40)).suspects).toEqual([]);
  });

  it('(f) flags a dominant variety whose price disagrees with the item', () => {
    const { api } = loadBackend();
    const prev = guardBoard(40);
    const suspects = (share: number, catty: number) =>
      api.validateBoard(boardWithItem({ varieties: [{ name: '甲', catty_price: catty, share_percent: share }] }), prev).suspects;

    expect(suspects(95, 20)).toEqual([]); // share exactly at the threshold
    expect(suspects(96, 15)).toEqual([]); // exactly 50% above the item's 10
    expect(suspects(96, 14)).toEqual([]);
    expect(suspects(96, 16)).toEqual(['品項0']);
    expect(suspects(96, 4)).toEqual(['品項0']); // and the cheap direction
  });

  it('lists an item that trips both item rules exactly once', () => {
    const { api } = loadBackend();
    const board = boardWithItem({
      change_percent: 300,
      trade_volume: 100,
      varieties: [{ name: '甲', catty_price: 40, share_percent: 99 }],
    });
    expect(api.validateBoard(board, guardBoard(40)).suspects).toEqual(['品項0']);
  });

  it('never rejects a board over its items — 39 good prices beat none', () => {
    const { api } = loadBackend();
    const verdict = api.validateBoard(
      boardWithItem({ change_percent: 900, trade_volume: 100, prev_volume: 60000 }), guardBoard(40));
    expect(verdict).toMatchObject({ ok: true, reasons: [], suspects: ['品項0'] });
  });

  it('markSuspects marks exactly the named items', () => {
    const { api } = loadBackend();
    const board = guardBoard(3);
    api.markSuspects(board, ['品項1']);
    expect(board.items.map((it) => it.suspect)).toEqual([undefined, true, undefined]);
  });
});

/**
 * The refresh path around the guard. What has to hold: a half-empty crawl
 * never reaches the cache, the durable props or the history; the operator can
 * see why from `diag` and from the existing failure mail; and a board that is
 * merely carrying one bad item is still published, minus that item's
 * observation.
 */
describe('refreshBoardCache — plausibility guard', () => {
  /**
   * MOA stub answering per (root, trading date). `loadBackend`'s shared
   * responder matches on the crop term alone, and the item-level rule needs
   * today's price to differ from yesterday's.
   */
  const moaByDate = (rowsFor: (root: string, roc: string) => Row[]) => {
    const reply = (url: string) => {
      const q = new URL(url).searchParams;
      return {
        getResponseCode: () => 200,
        getContentText: () =>
          JSON.stringify({ RS: 'OK', Data: rowsFor(q.get('CropName') ?? '', q.get('Start_time') ?? '') }),
      };
    };
    return {
      UrlFetchApp: {
        fetch: (url: string) => reply(url),
        fetchAll: (reqs: { url: string }[]) => reqs.map((r) => reply(r.url)),
      },
    };
  };

  /**
   * One row per board item on the requested root, so `defs` builds exactly
   * `defs.length` items — the roots left out are the throttled batch.
   */
  const rootRows =
    (defs: GuardDef[], priced: (name: string, roc: string) => { price: number; volume: number } = () => ({ price: 20, volume: 60000 })) =>
      (root: string, roc: string): Row[] =>
        defs
          .filter((def) => def.official === root)
          .map((def) => {
            const { price, volume } = priced(def.name, roc);
            return row(def.official + (def.variety ? `-${def.variety}` : ''), price, volume);
          });

  /** A healthy stored board of `count` real items at 20 元/公斤 = 12 元/台斤. */
  const storedBoardOf = (count: number) => ({
    type: 'board',
    date: new Date().toISOString().slice(0, 10),
    roc_date: rocDate(0),
    prev_date: rocDate(1),
    generated_at: new Date().toISOString(),
    count,
    items: GUARD_DEFS.slice(0, count).map((def) => ({
      code: def.official, name: def.name, official_name: def.official, category: def.category,
      avg_price: 20, catty_price: 12, change_percent: 0, trade_volume: 60000,
      unit: '公斤', markets_count: 6,
    })),
  });

  /** A refresh where only the first 40 roots answer — the throttled-batch shape. */
  const halfEmptyRefresh = () => {
    const backend = loadBackend({}, moaByDate(rootRows(GUARD_DEFS.slice(0, 40))));
    backend.api.storeBoard(storedBoardOf(94));
    return backend;
  };

  it('keeps the stored board when a throttled crawl yields 40 of 94 items', () => {
    const { api, props, cache } = halfEmptyRefresh();
    const good = api.readDurableBoard();

    const built = api.refreshBoardCache();

    expect(built.count).toBe(40); // the build really did happen...
    expect(api.readDurableBoard()).toBe(good); // ...and changed nothing
    expect(cache.get('veggie_board_v2')).toBe(good);
    expect(api.readHistory().items).toEqual({});
    expect(props.get('veggie_last_refresh_fail')).toContain('implausible: count 40 < 60% of previous 94');
    expect(props.has('veggie_last_refresh_ok')).toBe(false);
  });

  it('shows the verdict through diag, reasons and all', () => {
    const { api } = halfEmptyRefresh();
    api.refreshBoardCache();

    const diag = api.handleDiag();
    expect(diag.last_validation).toMatchObject({
      ok: false,
      reasons: ['count 40 < 60% of previous 94'],
      suspects: [],
    });
    expect(Date.parse(diag.last_validation.at)).not.toBeNaN();
    // The raw reason is still redacted to a category for anonymous callers,
    // even though this one is entirely our own text.
    expect(diag.last_refresh_fail).toMatch(/ implausible$/);
  });

  it('keeps the rejected board whole for inspection, chunked past the 9 KB cap', () => {
    const { api, props } = halfEmptyRefresh();
    api.refreshBoardCache();

    expect(Number(props.get(api.REJECTED_PROP_COUNT))).toBeGreaterThan(1);
    const rejected = JSON.parse(api.readChunkedProp(api.REJECTED_PROP_PREFIX, api.REJECTED_PROP_COUNT));
    expect(rejected.count).toBe(40);
    expect(rejected.items).toHaveLength(40);
  });

  it('reaches the operator through the existing streak alert, carrying the reasons', () => {
    const { api, mails } = halfEmptyRefresh();
    for (let i = 0; i < api.ALERT_FAILURE_STREAK; i++) api.refreshBoardCache();

    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain('連續 3 次更新失敗');
    expect(mails[0].body).toContain('implausible: count 40 < 60% of previous 94');
  });

  it('publishes a good board with one item flagged, and keeps it out of history', () => {
    const { api, props } = loadBackend(
      {},
      // 番茄 triples overnight on a tenth of its usual volume; everything else
      // trades exactly as it did yesterday.
      moaByDate(rootRows(GUARD_DEFS, (name, roc) =>
        name === '番茄' && roc === rocDate(0)
          ? { price: 90, volume: 6000 }
          : { price: 20, volume: 60000 })),
    );
    api.storeBoard(storedBoardOf(GUARD_DEFS.length));

    api.refreshBoardCache();

    const board = JSON.parse(api.readDurableBoard()) as { count: number; items: Record<string, unknown>[] };
    const flagged = board.items.filter((it) => it.suspect === true).map((it) => it.name);
    expect(flagged).toEqual(['番茄']);
    expect(board.count).toBe(GUARD_DEFS.length);
    expect(props.get('veggie_last_refresh_ok')).toContain(`${GUARD_DEFS.length} items`);

    // The flagged observation must not bend the 28-day median; its neighbours
    // are recorded as usual.
    const history = api.readHistory().items;
    expect(history['番茄']).toBeUndefined();
    expect(history['高麗菜']).toEqual([[rocDate(0), 20]]);
  });

  describe('the flag survives the day it was raised (#77)', () => {
    /** The names the published board carries `suspect: true` on. */
    const flagged = (api: { readDurableBoard: () => string }) =>
      (JSON.parse(api.readDurableBoard()) as { items: { name: string; suspect?: boolean }[] })
        .items.filter((it) => it.suspect === true).map((it) => it.name);

    /** 番茄 triples on a tenth of its volume; `todayVolume` can move between refreshes. */
    const refreshing = (todayVolume: () => number) =>
      loadBackend({}, moaByDate(rootRows(GUARD_DEFS, (name, roc) =>
        name === '番茄' && roc === rocDate(0)
          ? { price: 90, volume: todayVolume() }
          : { price: 20, volume: 60000 })));

    it('keeps it on the second refresh of the same trading day', () => {
      // The refresh runs every few hours. The second one of the day used to
      // compare today's volume against the stored board — which by then was
      // that same morning — so the rule could not fire and the item came back
      // unflagged, with its badges and its place in 划算優先 restored.
      const { api } = refreshing(() => 6000);
      api.storeBoard(storedBoardOf(GUARD_DEFS.length));

      api.refreshBoardCache();
      expect(flagged(api)).toEqual(['番茄']);

      api.refreshBoardCache();
      expect(flagged(api)).toEqual(['番茄']);
    });

    it('drops it when the volume recovers later the same day', () => {
      // The flag is not sticky either: it is a verdict on today's numbers, and
      // when those change the verdict changes with them.
      let volume = 6000;
      const { api } = refreshing(() => volume);
      api.storeBoard(storedBoardOf(GUARD_DEFS.length));

      api.refreshBoardCache();
      expect(flagged(api)).toEqual(['番茄']);

      volume = 60000; // the day's trading caught up with the price
      api.refreshBoardCache();
      expect(flagged(api)).toEqual([]);
    });

    it('never publishes the comparison the guard used', () => {
      // `prev_volume` is a build-time fact for the guard. The payload is a
      // contract (README §3) and the mirror is a copy of it.
      const { api } = refreshing(() => 6000);
      api.storeBoard(storedBoardOf(GUARD_DEFS.length));
      api.refreshBoardCache();

      const stored = JSON.parse(api.readDurableBoard()) as { items: Record<string, unknown>[] };
      expect(stored.items.some((it) => 'prev_volume' in it)).toBe(false);
    });

    it('never answers a live search with it either', () => {
      // `liveRootCards` builds its cards with the same `aggregateGroup`, and
      // caches them for an hour: a leak there outlives the request.
      const { api } = refreshing(() => 6000);
      const answer = api.handleSearch({ query: '番茄' }) as { items?: Record<string, unknown>[] };

      expect(answer.items?.length).toBeGreaterThan(0);
      expect(answer.items?.some((it) => 'prev_volume' in it)).toBe(false);
    });

    it('keeps it in the rejected copy, which is evidence rather than a payload', () => {
      const { api } = halfEmptyRefresh();
      api.refreshBoardCache();

      const rejected = JSON.parse(api.readChunkedProp(api.REJECTED_PROP_PREFIX, api.REJECTED_PROP_COUNT)) as
        { items: Record<string, unknown>[] };
      expect(rejected.items.every((it) => 'prev_volume' in it)).toBe(true);
    });
  });

  it('accepts the first board ever built, with nothing to compare it against', () => {
    const { api, props } = loadBackend({}, moaByDate(rootRows(GUARD_DEFS.slice(0, 30))));
    expect(api.readDurableBoard()).toBeNull();

    api.refreshBoardCache();

    expect(JSON.parse(api.readDurableBoard()).count).toBe(30); // exactly the floor
    expect(api.handleDiag().last_validation).toMatchObject({ ok: true, reasons: [], suspects: [] });
    expect(props.has('veggie_last_refresh_fail')).toBe(false);
  });

  it('treats a torn stored board as no board rather than failing the refresh', () => {
    const { api, props } = loadBackend({}, moaByDate(rootRows(GUARD_DEFS.slice(0, 30))));
    props.set('veggie_board_v2_chunks', '2');
    props.set('veggie_board_v2_chunk_0', '{"type":"board","items":[');

    api.refreshBoardCache();

    expect(JSON.parse(api.readDurableBoard()).count).toBe(30);
    expect(props.has('veggie_last_refresh_fail')).toBe(false);
  });

  it('replaces a good verdict when the next build comes back empty', () => {
    const { api, props } = loadBackend({}, moaByDate(rootRows(GUARD_DEFS.slice(0, 30))));
    api.refreshBoardCache();
    expect(api.handleDiag().last_validation.ok).toBe(true);

    // MOA answers nothing at all: no probe date, no board. diag must not keep
    // reporting the previous run's `ok: true` under this refresh.
    const empty = loadBackend();
    for (const [k, v] of props) empty.props.set(k, v);
    empty.api.refreshBoardCache();

    expect(empty.api.handleDiag().last_validation).toMatchObject({
      ok: false,
      reasons: ['近期查無交易資料'],
      suspects: [],
    });
    expect(empty.props.get('veggie_last_refresh_fail')).toMatch(/ 近期查無交易資料$/);
    expect(empty.props.has('veggie_board_rejected_chunks')).toBe(false); // nothing to inspect
  });

  it('reduces an implausible failure to a category for anonymous diag callers', () => {
    const { api } = loadBackend();
    expect(api.redactFailure('2026-09-02T00:10:00.000Z implausible: count 40 < 60% of previous 94'))
      .toBe('2026-09-02T00:10:00.000Z implausible');
  });
});


/**
 * The search index (#21). A query outside the board used to cost 8–31 s and
 * two live MOA queries whether or not the crop could exist at all: 「iphone」
 * and 「蓮子」 walked the same path. Three things are pinned here — that both
 * ends normalise a query identically, that an impossible query costs nothing,
 * and that a possible one costs one crawl per root per hour.
 */
describe('normalizeQuery — one contract, two implementations', () => {
  // The very fixture `src/lib/normalizeQuery.test.ts` runs against the
  // TypeScript implementation. Two implementations of one contract only stay
  // in step if one set of cases judges both.
  const FIXTURE = JSON.parse(
    readFileSync(resolve(__dirname, '../shared/normalize-query.fixture.json'), 'utf8'),
  ) as { in: string; out: string }[];
  const { api } = loadBackend();

  it.each(FIXTURE)('$in → $out', ({ in: input, out }) => {
    expect(api.normalizeQuery(input)).toBe(out);
  });

  it('keeps the typed form beside the root, because they match different rows', () => {
    expect(api.searchTerms('  ＴＯＭＡＴＯ ')).toEqual(['tomato', '番茄']);
    expect(api.searchTerms('甘藍')).toEqual(['甘藍']);
  });
});

describe('CROP_CATALOG', () => {
  const { api } = loadBackend();

  it('covers every board root, so the gate can never refuse a board item', () => {
    const missing = (api.BOARD_ITEMS as { official: string }[])
      .filter((def) => api.CROP_CATALOG.indexOf(def.official) === -1)
      .map((def) => def.official);
    expect(missing).toEqual([]);
  });

  it('holds every alias target, so no alias can resolve into a refusal', () => {
    // An alias whose root is not in the catalogue is a silent dead end: the
    // query resolves, the gate then says 查無此品項, and nothing fails until a
    // shopper types it. Catches both a typo'd alias and a stale catalogue.
    const targets = [...new Set(Object.values(api.SEARCH_ALIASES as Record<string, string>))];
    expect(targets.filter((root) => api.CROP_CATALOG.indexOf(root) === -1)).toEqual([]);
  });

  it('is sorted, deduplicated and big enough to be a real index', () => {
    // Sorted and unique because it is generated; a hand edit that breaks
    // either is a sign the file was edited instead of re-crawled.
    expect(api.CROP_CATALOG).toEqual([...api.CROP_CATALOG].sort());
    expect(new Set(api.CROP_CATALOG).size).toBe(api.CROP_CATALOG.length);
    // A complete crawl of the last 400 days sees 185 produce roots: the feed's
    // ~600 daily crop names are mostly cut flowers (`N06`, excluded) and
    // `<root>-<variety>` spellings of one root. The floor sits under that and
    // far over what a truncated crawl yields (a single sampled day reaches
    // ~120), so a half-finished refresh fails here without this test
    // pretending to know next quarter's exact count.
    expect(api.CROP_CATALOG.length).toBeGreaterThanOrEqual(150);
  });
});

describe('handleSearch — the three steps', () => {
  const board = () => ({
    type: 'board',
    date: '2026-09-02',
    roc_date: rocDate(0),
    generated_at: new Date().toISOString(),
    count: 2,
    items: [
      { name: '高麗菜', official_name: '甘藍', category: '葉菜類', catty_price: 14, trade_volume: 570700 },
      { name: '洋蔥', official_name: '洋蔥', category: '根莖類', catty_price: 12, trade_volume: 41635 },
    ],
  });

  // Every one of these reached MOA before: the client could not resolve them
  // and the backend only looked the raw string up on the board.
  it.each([
    ['cabbage', '甘藍'],
    ['ＣＡＢＢＡＧＥ', '甘藍'],
    ['高丽菜', '甘藍'],
    ['高麗菜多少錢', '甘藍'],
    ['蔥', '洋蔥'], // the typed term is kept beside its alias 青蔥, which alone would miss 洋蔥
    ['onion', '洋蔥'],
    ['洋葱', '洋蔥'],
  ])('answers %s from the board with zero MOA traffic', (query, official) => {
    const { api, fetches } = loadBackend();
    api.storeBoard(board());

    const res = api.handleSearch({ query });
    expect(res.type).toBe('search');
    expect(res.items.map((it: { official_name: string }) => it.official_name)).toContain(official);
    expect(fetches).toHaveLength(0);
  });

  it('refuses a query no catalogue root relates to, with zero MOA traffic', () => {
    // This is where the 8–31 s went: gibberish, typos and non-produce
    // searches all used to probe trading dates and run two live queries.
    const { api, fetches } = loadBackend({ 甘藍: [row('甘藍-初秋', 20, 60000)] });
    api.storeBoard(board());

    for (const query of ['xyz', 'iphone', '哈哈哈哈']) {
      const res = api.handleSearch({ query });
      expect(res.error, query).toBe('查無此品項');
      expect(res.suggestion, query).toMatch(/^試試：/);
      const names = res.suggestion.replace('試試：', '').split('、');
      expect(names.length, query).toBeLessThanOrEqual(api.SEARCH_MAX_SUGGESTIONS);
    }
    expect(fetches).toHaveLength(0);
  });

  it('offers roots one edit from a typo, and what is trading when nothing is close', () => {
    const { api, fetches } = loadBackend();
    // 高麗菜 is a board name, so a typo of a real ROOT is what exercises this.
    const typo = api.handleSearch({ query: '甘籃' }); // 甘藍 with the wrong 藍
    expect(typo.error).toBe('查無此品項');
    const suggested = typo.suggestion.replace('試試：', '').split('、');
    expect(suggested.length).toBeLessThanOrEqual(api.SEARCH_MAX_SUGGESTIONS);
    for (const name of suggested) expect(api.withinOneEdit(name, '甘籃'), name).toBe(true);

    // Nothing is one edit from gibberish, so the offer becomes the board's
    // biggest sellers — volume order, not definition order.
    api.storeBoard(board());
    expect(api.handleSearch({ query: 'iphone' }).suggestion).toBe('試試：高麗菜、洋蔥');
    expect(fetches).toHaveLength(0);
  });

  it('measures one edit exactly, in either direction', () => {
    const { api } = loadBackend();
    expect(api.withinOneEdit('甘藍', '甘籃')).toBe(true); // substitution
    expect(api.withinOneEdit('甘藍', '藍')).toBe(true); // deletion
    expect(api.withinOneEdit('甘藍', '甘藍菜')).toBe(true); // insertion
    expect(api.withinOneEdit('甘藍', '甘薯葉')).toBe(false);
    expect(api.withinOneEdit('甘藍', '花椰菜')).toBe(false);
  });

  it('caps the fan-out, so a one-character query cannot crawl the whole feed', () => {
    const { api } = loadBackend();
    expect(api.catalogRoots(['菜']).length).toBeLessThanOrEqual(api.SEARCH_MAX_ROOTS);
    expect(api.catalogRoots(['甘藍'])[0]).toBe('甘藍'); // an exact root always leads
  });

  it('runs a catalogue hit live once, then serves it from the cache', () => {
    const officials = new Set((loadBackend().api.BOARD_ITEMS as { official: string }[]).map((d) => d.official));
    const offBoard = (loadBackend().api.CROP_CATALOG as string[]).find((root) => !officials.has(root));
    if (!offBoard) throw new Error('the catalogue holds nothing beyond the board');

    const { api, fetches, cache } = loadBackend({
      甘藍: [row('甘藍-初秋', 20, 60000)], // feeds the trading-date probe
      [offBoard]: [row(`${offBoard}-一般`, 30, 5000)],
    });
    const first = api.handleSearch({ query: offBoard });
    expect(first.items.map((it: { official_name: string }) => it.official_name)).toContain(offBoard);
    const afterFirst = fetches.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect([...cache.keys()].some((k) => k.startsWith(`${api.SEARCH_CACHE_PREFIX}${offBoard}_`))).toBe(true);

    // Same query, same hour: the crawl is shared with every other visitor.
    const second = api.handleSearch({ query: offBoard });
    expect(second.items).toEqual(first.items);
    expect(fetches).toHaveLength(afterFirst);
  });

  it('keys a cached answer by the trading date it describes', () => {
    // A miss cached on Saturday must not answer Monday's question. The key
    // carries the resolved trading date, so yesterday's payload is not a hit.
    const { api, cache, fetches } = loadBackend({
      甘藍: [row('甘藍-初秋', 20, 60000)], // moves the trading-date probe
      蓮藕: [row('蓮藕-一般', 60, 5000)],
    });
    const yesterday = `${api.SEARCH_CACHE_PREFIX}蓮藕_${rocDate(1)}`;
    cache.set(yesterday, JSON.stringify({ date: '2026-09-01', rows: 0, items: [] }));

    const res = api.handleSearch({ query: '蓮藕' });

    expect(res.items.map((it: { official_name: string }) => it.official_name)).toEqual(['蓮藕']);
    expect(fetches.length).toBeGreaterThan(0);
    expect([...cache.keys()]).toContain(`${api.SEARCH_CACHE_PREFIX}蓮藕_${rocDate(0)}`);
    expect(cache.get(yesterday)).toContain('"rows":0'); // untouched, and unused
  });

  it('keeps the board’s variety guards on a live answer', () => {
    // 青椒 and 甜椒 share the MOA root 甜椒 and are two board items split by
    // `variety` / `excludes`. A live answer that skipped `selectRows` would
    // report one blended average the board deliberately never shows.
    const { api } = loadBackend({
      甘藍: [row('甘藍-初秋', 20, 60000)],
      甜椒: [row('甜椒-青椒', 30, 5000), row('甜椒-紅', 90, 5000), row('甜椒-黃', 100, 5000)],
    });

    const res = api.handleSearch({ query: '青椒' });
    const priceByName: Record<string, number> = {};
    for (const item of res.items as { name: string; avg_price: number }[]) priceByName[item.name] = item.avg_price;
    expect(Object.keys(priceByName).sort()).toEqual(['甜椒', '青椒']);
    expect(priceByName['青椒']).toBe(30); // only the 青椒 rows
    expect(priceByName['甜椒']).toBe(95); // the other two, exactly as the board splits them
  });

  it('stops refusing once the catalogue is too old to be trusted', () => {
    // The crawl samples 100 of 400 days, so a whole season can hide between
    // two samples, and MOA does add roots. Inside the freshness window the
    // gate is the feature; past it a list nobody re-crawled must not outlive
    // the crops it forgot, so search falls back to the live query.
    const { api } = loadBackend();
    const crawled = Date.parse(api.CROP_CATALOG_CRAWLED_AT);
    const day = 24 * 60 * 60 * 1000;
    expect(api.catalogUsable(crawled + (api.CATALOG_MAX_AGE_DAYS - 1) * day)).toBe(true);
    expect(api.catalogUsable(crawled + api.CATALOG_MAX_AGE_DAYS * day)).toBe(false);

    const stale = loadBackend(
      { 甘藍: [row('甘藍-初秋', 20, 60000)], 哈哈哈哈: [row('哈哈哈哈-一般', 40, 5000)] },
      { Date: expiredClock(crawled + 400 * day) },
    );
    const res = stale.api.handleSearch({ query: '哈哈哈哈' });
    expect(res.items.map((it: { official_name: string }) => it.official_name)).toEqual(['哈哈哈哈']);
    expect(stale.fetches.length).toBeGreaterThan(0);
  });
});