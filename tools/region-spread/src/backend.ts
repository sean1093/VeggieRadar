/**
 * This tool's window into the live Apps Script backend.
 *
 * The whole point of the measurement is to predict what `aggregateGroup` would
 * publish if it grouped by region, so every number here has to come out of the
 * code that actually serves the board: `BOARD_ITEMS` is the item list,
 * `selectRows` is the substring/variety filter that stops 蔥 eating 洋蔥,
 * `weightedAverage` is the blend, `MIN_TRADE_VOLUME` is the gate a card must
 * clear and `CATTY_PER_KG` is the unit the app displays. Re-implementing any of
 * them here would measure a board that does not exist.
 *
 * The loading trick is the repository's own (`tools/calibrate/src/backend.ts`,
 * `frontend/backendCode.test.ts`): Apps Script merges every `.gs` into one
 * global scope, so concatenating them and evaluating the result reproduces that
 * scope. Every GAS service is stubbed to throw — this tool must reach MOA
 * through its own cached fetcher, and a stub that returned something plausible
 * would hide a mistake instead of failing on it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');
export const BACKEND_DIR = resolve(REPO_ROOT, 'backend');

/** One MOA transaction row, as the API returns it. */
export type MoaRow = {
  TransDate?: string;
  CropCode?: string;
  CropName?: string;
  MarketCode?: string;
  MarketName?: string;
  Avg_Price?: number;
  Trans_Quantity?: number;
};

/** A board item definition from `BOARD_ITEMS`. */
export type CropDef = {
  name: string;
  official: string;
  category: string;
  variety?: string;
  excludes?: string[];
};

export type WeightedAverage = { avg: number; volume: number; markets: number };

export type Backend = {
  BOARD_ITEMS: CropDef[];
  MIN_TRADE_VOLUME: number;
  CATTY_PER_KG: number;
  BACKFILL_WINDOW_DAYS: number;
  AGRICULTURE_API_URL: string;
  selectRows: (rows: MoaRow[], def: CropDef) => MoaRow[];
  tradedRows: (rows: MoaRow[]) => MoaRow[];
  weightedAverage: (rows: MoaRow[]) => WeightedAverage;
  median: (values: number[]) => number;
  boardRoots: () => string[];
  dateToROC: (d: Date) => string;
  rocToISO: (roc: string) => string;
  cropUrl: (cropName: string, rocStart: string, rocEnd?: string) => string;
};

const EXPORTED = [
  'BOARD_ITEMS', 'MIN_TRADE_VOLUME', 'CATTY_PER_KG', 'BACKFILL_WINDOW_DAYS',
  'AGRICULTURE_API_URL', 'selectRows', 'tradedRows', 'weightedAverage',
  'median', 'boardRoots', 'dateToROC', 'rocToISO', 'cropUrl',
];

function refuse(service: string): never {
  throw new Error(`region-spread must not call ${service}: only the pure helpers are in scope`);
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

/** Loads (once) the merged backend scope and returns the helpers this tool needs. */
export function loadBackend(): Backend {
  if (cached) return cached;
  const merged = readdirSync(BACKEND_DIR)
    .filter((f) => f.endsWith('.gs'))
    .sort()
    .map((name) => readFileSync(resolve(BACKEND_DIR, name), 'utf8'))
    .join('\n');
  const factory = new Function(
    ...Object.keys(SERVICES),
    `${merged}\nreturn { ${EXPORTED.join(', ')} };`,
  );
  cached = factory(...Object.values(SERVICES)) as Backend;
  return cached;
}
