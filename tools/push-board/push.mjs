#!/usr/bin/env node
/**
 * Crawl MOA from here — a machine in Taiwan, which MOA answers — and push the
 * rows to the backend, which builds the board from them as a refresh would
 * (#103). See README.md.
 *
 *   ADMIN_TOKEN=… node push.mjs            # crawl and push
 *   node push.mjs --dry-run                # crawl only, and say what it found
 */
process.env.TZ = 'Asia/Taipei'; // the trading date is Taiwan's, wherever this runs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackend } from './backend.mjs';
import { crawl } from './crawl.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

function apiBase() {
  const flag = args.find((a) => a.startsWith('--api='));
  if (flag) return flag.slice('--api='.length);
  if (process.env.API_BASE_URL) return process.env.API_BASE_URL;
  const env = readFileSync(resolve(HERE, '../../frontend/.env'), 'utf8');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('VITE_API_BASE_URL='));
  if (!line) throw new Error('no API base URL: pass --api=… or set API_BASE_URL');
  return line.slice('VITE_API_BASE_URL='.length).trim();
}

/** One GET, synchronous as UrlFetchApp is: curl, which macOS, Linux and Windows 10+ ship. */
function get(url) {
  try {
    const out = execFileSync('curl', ['-sS', '--max-time', '60', '-w', '\n%{http_code}', url], { maxBuffer: 1 << 28 }).toString('utf8');
    const cut = out.lastIndexOf('\n');
    return { status: Number(out.slice(cut + 1)) || 0, body: out.slice(0, cut) };
  } catch (err) {
    if (verbose) console.error(`  ${url}: ${err.message}`);
    return { status: 0, body: '' };
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const token = process.env.ADMIN_TOKEN;
if (!dryRun && !token) {
  console.error('ADMIN_TOKEN is not set: it is the ADMIN_TOKEN script property (or run with --dry-run).');
  process.exit(2);
}

console.log('Crawling MOA…');
const started = Date.now();
const api = loadBackend(get, { sleep, log: verbose ? (m) => console.error(`  ${m}`) : () => {} });
const { payload, summary } = crawl(api);
console.log(`  trading date ${summary.latest ?? 'none found'}, previous ${summary.prev ?? 'none'}; ` +
  `${summary.answered}/${summary.roots} roots answered in ${Math.round((Date.now() - started) / 1000)} s`);
if (summary.unanswered.length) console.log(`  unanswered: ${summary.unanswered.join('、')}`);
if (!payload) {
  console.error('No trading date found: MOA did not answer. Is this machine in Taiwan?');
  process.exit(1);
}
if (dryRun) process.exit(0);

console.log('Pushing to the backend…');
const url = `${apiBase()}?action=push&token=${encodeURIComponent(token)}`;
const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const text = await res.text();
let out;
try {
  out = JSON.parse(text);
} catch {
  // An older deployment has no doPost, and Apps Script says so in HTML.
  console.error(/doPost/.test(text)
    ? 'The Web App does not take a push yet: run `clasp push` and `clasp deploy -i <deployment id>`.'
    : `The backend answered ${res.status}, not JSON: ${text.slice(0, 200)}`);
  process.exit(1);
}
if (out.error === 'unauthorized') {
  console.error('Refused: ADMIN_TOKEN does not match the script property.');
  process.exit(1);
}
if (out.error === 'unknown action' || (out.type && out.type !== 'push')) {
  console.error('The Web App does not take a push yet: run `clasp push` and `clasp deploy -i <deployment id>`.');
  process.exit(1);
}
if (!out.stored) {
  console.error(`Not stored: ${out.message || (out.reasons || []).join('; ') || JSON.stringify(out)}`);
  process.exit(1);
}
console.log(`Stored: ${out.count} items for ${out.roc_date}, generated ${out.generated_at}.`);
