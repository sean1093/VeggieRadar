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
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackend } from './backend.mjs';
import { crawl } from './crawl.mjs';
import { isTransient, withRetry } from '../../frontend/scripts/gas-retry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

/** The Web App's `/exec` URL, checked: a bad one should fail before the crawl, not after. */
function apiBase() {
  const url = configuredApi().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]/.test(url) || !URL.canParse(url)) throw new Error(`not a Web App URL: "${url}"`);
  return url;
}

function configuredApi() {
  const flag = args.find((a) => a.startsWith('--api='));
  if (flag) return flag.slice('--api='.length);
  if (process.env.API_BASE_URL) return process.env.API_BASE_URL;
  // As `frontend/scripts/prod-probe.mjs` reads it, quotes allowed.
  const env = readFileSync(resolve(HERE, '../../frontend/.env'), 'utf8');
  const match = env.match(/^\s*VITE_API_BASE_URL\s*=\s*(\S+)\s*$/m);
  if (!match) throw new Error('no VITE_API_BASE_URL in frontend/.env: pass --api=… or set API_BASE_URL');
  return match[1].replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * POSTs `body` and answers `{status, text, redirected}`, following Apps Script's redirect
 * to the output as a GET, as a browser does. Not `fetch`: its 300 s wait for
 * the answer's headers is shorter than the refresh the push runs, which may
 * take all of Apps Script's six minutes.
 */
function post(url, body, deadline = Date.now() + 7 * 60 * 1000, hops = 5) {
  return new Promise((resolveIt, rejectIt) => {
    // One deadline for the whole exchange, every hop and a trickled answer included.
    let req;
    const timer = setTimeout(() => req.destroy(new Error('no answer in 7 min')), Math.max(0, deadline - Date.now()));
    const done = (v) => { clearTimeout(timer); resolveIt(v); };
    const fail = (e) => { clearTimeout(timer); rejectIt(e); };
    const target = new URL(url);
    const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
    req = send(target, body === null ? { method: 'GET' } : {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
          post(new URL(res.headers.location, target).href, null, deadline, hops - 1).then(done, fail);
        } else {
          done({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), redirected: body === null });
        }
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(body ?? undefined);
  });
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
const { payload, error, roots, unanswered } = crawl(backend);
const took = `${Math.round((Date.now() - started) / 1000)} s`;
if (!payload) {
  // The backend's own words: no trading date found, or the crawl cut short.
  console.error(`  ${error} (${took})`);
  console.error('MOA did not answer the crawl. Is this machine in Taiwan?');
  process.exit(1);
}
const { dates } = payload;
const answered = (day) => `${roots - unanswered[day].length}/${roots}`;
console.log(`  trading date ${dates.latest}: ${answered('latest')} roots answered; ` +
  `previous ${dates.prev ? `${dates.prev}: ${answered('prev')}` : 'none'}; in ${took}`);
for (const day of ['latest', 'prev']) {
  // Kept out of the board as a scheduled refresh would keep them, after its
  // retry: said here because the operator, unlike the trigger, can re-run.
  if (unanswered[day].length) console.log(`  unanswered on ${dates[day]}: ${unanswered[day].join('、')}`);
}
if (dryRun) process.exit(0);

console.log('Pushing to the backend…');
const withParams = (params) => {
  const url = new URL(api);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
};
const url = withParams({ action: 'push', token });
const pushedAt = Date.now();
const NOT_DEPLOYED = 'The Web App does not take a push yet: run `clasp push` and `clasp deploy -i <deployment id>`.';

/**
 * Whether `diag` shows this push's day stored since it began (`last_refresh_ok`
 * is "<generated_at> <roc date> <count> items"), for when the push itself
 * could not say: what the refresh did is there either way.
 */
async function reportFromDiag() {
  try {
    const got = await withRetry(async (u) => {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
        return { status: r.status, body: await r.text() };
      } catch (err) {
        return { error: err };
      }
    }, withParams({ action: 'diag' }));
    const diag = JSON.parse(got.body);
    const ok = String(diag.last_refresh_ok || '');
    const [at, day] = ok.split(' ');
    // A minute's grace for the two clocks.
    console.error(day === dates.latest && Date.parse(at) >= pushedAt - 60_000
      ? `It was stored all the same: diag.last_refresh_ok reads "${ok}".`
      : `diag.last_refresh_ok reads "${ok || 'nothing'}": not stored by this push, yet. Check ?action=diag again in a few minutes before pushing again.`);
  } catch {
    console.error('Nor from ?action=diag: check it in a few minutes before pushing again.');
  }
}

// A 404 or 5xx to the POST itself is Apps Script's own page — a cold start,
// or Google having a moment — so doPost never ran and asking again is safe
// (gas-retry.mjs). Not after the redirect, which comes once doPost has run,
// nor with no answer at all: the refresh may have run, or still be running.
const res = await withRetry(async (u) => {
  try {
    return await post(u, JSON.stringify(payload));
  } catch (err) {
    return { error: err };
  }
}, url, { transient: (r) => !r.error && !r.redirected && isTransient(r) });
if (res.error) {
  console.error(`No answer from the backend (${res.error.code || res.error.message}).`);
  await reportFromDiag();
  process.exit(1);
}
const text = res.text;
let out;
try {
  out = JSON.parse(text);
} catch {
  // An older deployment has no doPost, and Apps Script says so in HTML.
  if (/doPost/.test(text)) {
    console.error(NOT_DEPLOYED);
  } else {
    console.error(`The backend answered ${res.status}, not JSON (after ${res.attempts} attempts): ${text.slice(0, 200)}`);
    // Apps Script's own page, after doPost ran — its time limit, say.
    if (res.redirected) await reportFromDiag();
  }
  process.exit(1);
}
if (out.error === 'unauthorized') {
  console.error('Refused: ADMIN_TOKEN does not match the script property.');
  process.exit(1);
}
if (out.error === 'unknown action' || (out.type && out.type !== 'push')) {
  console.error(NOT_DEPLOYED);
  process.exit(1);
}
if (out.busy) {
  console.error('Another push is still being stored: check ?action=diag in a few minutes rather than pushing again.');
  process.exit(1);
}
if (!out.stored) {
  console.error(`Not stored: ${out.message || (out.reasons || []).join('; ') || JSON.stringify(out)}`);
  // A refresh that threw may have thrown after the store.
  if (out.error) await reportFromDiag();
  process.exit(1);
}
console.log(`Stored: ${out.count} items for ${out.roc_date}, generated ${out.generated_at}.`);
