/**
 * This tool's window into the backend: every `backend/*.gs` evaluated in one
 * scope, as Apps Script merges them, so the crawl run here is the backend's
 * own — the same roots, trading-date probe, batches and retries. Only the
 * services differ: an in-memory store, and `fetchImpl` for UrlFetchApp.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../backend');

/**
 * @param {(url: string) => {status: number, body: string}} fetchImpl one
 *   synchronous HTTP GET, as UrlFetchApp's is.
 * @param {{sleep?: (ms: number) => void, log?: (msg: string) => void}} [opts]
 */
export function loadBackend(fetchImpl, { sleep = () => {}, log = () => {} } = {}) {
  const src = readdirSync(BACKEND_DIR).filter((f) => f.endsWith('.gs')).sort()
    .map((f) => readFileSync(resolve(BACKEND_DIR, f), 'utf8')).join('\n');
  const store = new Map();
  const cache = new Map();
  const response = (r) => ({ getResponseCode: () => r.status, getContentText: () => r.body });
  const services = {
    Logger: { log: (m) => log(String(m)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => store.get(k) ?? null,
      setProperty: (k, v) => void store.set(k, String(v)),
      setProperties: (o) => Object.entries(o).forEach(([k, v]) => store.set(k, String(v))),
      deleteProperty: (k) => void store.delete(k),
      getProperties: () => Object.fromEntries(store),
    }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => cache.get(k) ?? null, put: (k, v) => void cache.set(k, v), remove: (k) => void cache.delete(k),
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Utilities: { sleep },
    UrlFetchApp: {
      fetch: (url) => response(fetchImpl(url)),
      fetchAll: (reqs) => reqs.map((r) => response(fetchImpl(typeof r === 'string' ? r : r.url))),
    },
  };
  const names = ['resolveTradeDates', 'boardRoots', 'fetchRootRows', 'PROBE_ROOT'];
  return new Function(...Object.keys(services), `${src}\nreturn { ${names.join(', ')} };`)(...Object.values(services));
}
