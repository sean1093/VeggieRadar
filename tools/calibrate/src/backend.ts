/**
 * The calibration tool's window into the live Apps Script backend.
 *
 * `selectRows`, `rowRoot`, `tradedRows`, `weightedAverage`, `median` and the
 * `BOARD_ITEMS` table only exist as `backend/*.gs`. Re-implementing them here
 * would let the offline fit and the served board drift apart silently — the
 * exact failure that makes a calibration untrustworthy — so the tool loads the
 * real source the same way `frontend/backendCode.test.ts` does: concatenate
 * every `.gs` (Apps Script merges them into one global scope) and evaluate it
 * with stubbed GAS services.
 *
 * The stubs throw. Nothing this tool calls may touch a GAS service: the row
 * helpers are pure, and a stub that quietly returned a plausible value would
 * hide a mistake instead of failing it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');
export const BACKEND_DIR = resolve(REPO_ROOT, 'backend');

/** One MOA transaction row, as the API returns it. */
export type MoaRow = {
  TransDate: string;
  CropCode?: string;
  CropName: string;
  MarketCode?: string;
  MarketName?: string;
  Avg_Price: number;
  Trans_Quantity: number;
};

/** A board item definition from `BOARD_ITEMS`, or a bare root for a crop that has none. */
export type CropDef = {
  name?: string;
  official: string;
  variety?: string;
  excludes?: string[];
  category?: string;
};

export type WeightedAverage = { avg: number; volume: number; markets: number };

export type Backend = {
  BOARD_ITEMS: Required<Pick<CropDef, 'name' | 'official' | 'category'>>[] & CropDef[];
  RETAIL_MARKUP_ROOT: Record<string, number>;
  RETAIL_BAND_ROOT: Record<string, number[]>;
  RETAIL_MARKUP_CATEGORY: Record<string, number[]>;
  CATTY_PER_KG: number;
  MIN_TRADE_VOLUME: number;
  BACKFILL_WINDOW_DAYS: number;
  FETCH_BATCH: number;
  AGRICULTURE_API_URL: string;
  RETAIL_BAND_LOW: number;
  RETAIL_BAND_HIGH: number;
  selectRows: (rows: MoaRow[], def: CropDef) => MoaRow[];
  tradedRows: (rows: MoaRow[]) => MoaRow[];
  rowRoot: (cropName: string) => string;
  rowVariety: (cropName: string) => string;
  weightedAverage: (rows: MoaRow[]) => WeightedAverage;
  median: (values: number[]) => number;
  retailBand: (catty: number, root: string, category: string) => { low: number; mid: number; high: number };
  categoryOf: (root: string) => string;
  boardRoots: () => string[];
  dateToROC: (d: Date) => string;
  rocToISO: (roc: string) => string;
  cropUrl: (cropName: string, rocStart: string, rocEnd?: string) => string;
};

const EXPORTED = [
  'BOARD_ITEMS', 'RETAIL_MARKUP_ROOT', 'RETAIL_BAND_ROOT', 'RETAIL_MARKUP_CATEGORY',
  'CATTY_PER_KG', 'MIN_TRADE_VOLUME', 'BACKFILL_WINDOW_DAYS', 'FETCH_BATCH',
  'AGRICULTURE_API_URL', 'RETAIL_BAND_LOW', 'RETAIL_BAND_HIGH',
  'selectRows', 'tradedRows', 'rowRoot', 'rowVariety', 'weightedAverage', 'median',
  'retailBand', 'categoryOf', 'boardRoots', 'dateToROC', 'rocToISO', 'cropUrl',
];

/** Every GAS global the backend names, stubbed to throw. */
function refuse(service: string): never {
  throw new Error(`calibration must not call ${service}: only the pure row helpers are in scope`);
}

const SERVICES: Record<string, unknown> = {
  UrlFetchApp: { fetch: () => refuse('UrlFetchApp'), fetchAll: () => refuse('UrlFetchApp') },
  CacheService: { getScriptCache: () => refuse('CacheService') },
  PropertiesService: { getScriptProperties: () => refuse('PropertiesService') },
  LockService: { getScriptLock: () => refuse('LockService') },
  MailApp: { sendEmail: () => refuse('MailApp') },
  Logger: { log: () => refuse('Logger') },
  Utilities: { sleep: () => refuse('Utilities') },
  ContentService: { createTextOutput: () => refuse('ContentService'), MimeType: { JSON: 'json' } },
  ScriptApp: {
    getProjectTriggers: () => refuse('ScriptApp'),
    deleteTrigger: () => refuse('ScriptApp'),
    newTrigger: () => refuse('ScriptApp'),
  },
};

let cached: Backend | null = null;

/** Loads (once) the merged backend scope and returns the helpers the tool needs. */
export function loadBackend(): Backend {
  if (cached) return cached;
  cached = evaluateBackend(readBackendSources());
  return cached;
}

/**
 * The backend as it is COMMITTED, not as it sits in the working tree.
 *
 * `RetailCalibration.gs` is this tool's own output, so a run that has already
 * written it would otherwise read its own proposal back as the deployed
 * baseline: the old-vs-new comparison would compare a proposal with itself,
 * and `--keep-shipped` would freeze the proposal instead of preserving what is
 * live. Reading the generated file out of `git show HEAD:` removes that
 * ordering trap — a rerun is idempotent whatever is lying in the tree.
 *
 * When HEAD has no generated file (the commit that introduces this tool), the
 * tables still live in `Config.gs`, so the working tree minus the generated
 * file is exactly the deployed state.
 */
export function loadCommittedBackend(): Backend {
  const sources = readBackendSources().filter((s) => s.name !== GENERATED_FILE);
  const committed = gitShow(`HEAD:backend/${GENERATED_FILE}`);
  if (committed !== null) sources.push({ name: GENERATED_FILE, source: committed });
  return evaluateBackend(sources);
}

const GENERATED_FILE = 'RetailCalibration.gs';

function readBackendSources(): { name: string; source: string }[] {
  return readdirSync(BACKEND_DIR)
    .filter((f) => f.endsWith('.gs'))
    .sort()
    .map((name) => ({ name, source: readFileSync(resolve(BACKEND_DIR, name), 'utf8') }));
}

/** Apps Script merges every file into one global scope; so does this. */
function evaluateBackend(sources: { name: string; source: string }[]): Backend {
  const merged = sources.map((s) => s.source).join('\n');
  const factory = new Function(...Object.keys(SERVICES), `${merged}\nreturn { ${EXPORTED.join(', ')} };`);
  return factory(...Object.values(SERVICES)) as Backend;
}

/** A committed file's content, or null when the path is not in that revision. */
function gitShow(revPath: string): string | null {
  try {
    return execFileSync('git', ['show', revPath], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/**
 * The filter a retail observation for `root` must be joined against.
 *
 * At runtime the markup is keyed by MOA ROOT but applied to a board item's
 * variety-filtered wholesale price, so the join has to use the same filter or
 * the fitted markup absorbs a variety spread that the runtime never sees.
 *
 *   - exactly one board item on the root → use its def, inheriting the
 *     `variety`/`excludes` guards that stop 蘿蔔 eating 胡蘿蔔 and 柿子 eating 柿餅;
 *   - several board items share the root (花椰菜 白/青, 甜椒 青椒/甜椒) → no single
 *     filter can serve them all, so fit against the whole root: its blended
 *     wholesale is the volume-weighted mean of the cards the markup will feed.
 *
 * A caller that knows the retail row names one of those varieties passes
 * `itemName` and gets that card's def instead.
 */
export function defForRoot(backend: Backend, root: string, itemName?: string): CropDef {
  const items = backend.BOARD_ITEMS.filter((d) => d.official === root);
  if (itemName) {
    const named = items.find((d) => d.name === itemName);
    if (!named) throw new Error(`board item ${itemName} is not defined on root ${root}`);
    return named;
  }
  if (items.length === 1) return items[0];
  const category = items.length ? items[0].category : backend.categoryOf(root);
  return { official: root, category };
}
