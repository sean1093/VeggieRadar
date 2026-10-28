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

/** One batch of GETs, made together and waited for synchronously, as UrlFetchApp's `fetchAll` is. */
function fetchBatch(urls) {
  let answers;
  try {
    const out = execFileSync(process.execPath, [resolve(HERE, 'fetch-batch.mjs')],
      { input: JSON.stringify(urls), maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'inherit'] });
    answers = JSON.parse(out.toString('utf8'));
  } catch (err) {
    answers = urls.map(() => ({ status: 0, body: '', error: err.message }));
  }
  if (verbose) answers.forEach((a, i) => a.status !== 200 && console.error(`  ${urls[i]}: ${a.error || a.status}`));
  return answers;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const token = process.env.ADMIN_TOKEN;
if (!dryRun && !token) {
  console.error('ADMIN_TOKEN is not set: it is the ADMIN_TOKEN script property (or run with --dry-run).');
  process.exit(2);
}
// Before the crawl, which takes minutes: a missing URL should not cost one.
let api;
try {
  api = dryRun ? null : apiBase();
} catch (err) {
  console.error(err.code === 'ENOENT' ? 'No frontend/.env: pass --api=… or set API_BASE_URL.' : err.message);
  process.exit(2);
}

console.log('Crawling MOA…');
const started = Date.now();
const backend = loadBackend(fetchBatch, { sleep, log: verbose ? (m) => console.error(`  ${m}`) : () => {} });
const { payload, error, summary } = crawl(backend);
const took = `${Math.round((Date.now() - started) / 1000)} s`;
if (!payload) {
  // The backend's own words: no trading date found, or the crawl cut short.
  console.error(`  ${error} (${took})`);
  console.error('MOA did not answer the crawl. Is this machine in Taiwan?');
  process.exit(1);
}
const answered = (day) => `${summary.roots - summary.unanswered[day].length}/${summary.roots}`;
console.log(`  trading date ${summary.latest}: ${answered('latest')} roots answered; ` +
  `previous ${summary.prev ? `${summary.prev}: ${answered('prev')}` : 'none'}; in ${took}`);
for (const day of ['latest', 'prev']) {
  // Kept out of the board as a scheduled refresh would keep them, after its
  // retry: said here because the operator, unlike the trigger, can re-run.
  const missed = summary.unanswered[day];
  if (missed.length) console.log(`  unanswered on ${summary[day]}: ${missed.join('、')}`);
}
if (dryRun) process.exit(0);

console.log('Pushing to the backend…');
const url = `${api}?action=push&token=${encodeURIComponent(token)}`;
let res;
let text;
try {
  res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  text = await res.text();
} catch (err) {
  // The refresh runs while the request waits, and may outlast it: what it
  // did is in `diag`, which says whether this push's day was stored.
  console.error(`No answer from the backend (${err.cause?.code || err.message}).`);
  try {
    const diag = await (await fetch(`${api}?action=diag`)).json();
    const ok = String(diag.last_refresh_ok || '');
    console.error(ok.includes(` ${payload.dates.latest} `)
      ? `It was stored all the same: diag.last_refresh_ok reads "${ok}".`
      : `diag.last_refresh_ok reads "${ok || 'nothing'}": not stored yet. Check ?action=diag again in a few minutes before pushing again.`);
  } catch {
    console.error('Nor from ?action=diag: check it in a few minutes before pushing again.');
  }
  process.exit(1);
}
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
