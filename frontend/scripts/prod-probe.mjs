/**
 * External production probe — the only thing that watches VeggieRadar from
 * outside its own runtime.
 *
 * Everything else that could notice an outage runs *inside* whatever breaks:
 * the failure mail is sent by the same Apps Script project whose deploy,
 * OAuth scopes or mail quota is the likely fault, and the frontend's degraded
 * modes are designed to stay quiet in front of a shopper. So this script calls
 * the public endpoints the way a visitor would and holds them to the
 * executable contract (`src/types/board.schema.ts`) plus a freshness bound —
 * an HTTP 200 says nothing about whether the board still has prices in it.
 *
 * Run from `frontend/`:
 *   node --experimental-strip-types scripts/prod-probe.mjs
 *
 * The flag is required on Node 22.6–22.17 and a harmless no-op from 22.18 on.
 * It is what lets this dependency-free script import the very TypeScript
 * schema the app validates against, rather than a copy that would drift — and
 * drift between the checker and the checked is the failure this exists to
 * prevent.
 *
 * Configuration (all optional):
 *   PAGES_URL     GitHub Pages origin, default the production site
 *   API_BASE_URL  GAS /exec URL, default VITE_API_BASE_URL from frontend/.env
 *   MIRROR_URL    static board mirror, default ${PAGES_URL}data/board.json
 *   OUT           result JSON path, default probe-result.json
 *
 * Exit code 1 means at least one check failed; `OUT` always describes what
 * happened, so the workflow can report a failure without parsing stdout.
 *
 * Freshness is judged on `generated_at` ALONE. `date` is the trading date of
 * the prices and legitimately stands still over weekends, holidays and typhoon
 * closures (README §2, "Trading date vs. refresh time") — comparing it with
 * today is how a normal market closure would page a human every Sunday.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_HEALTHY_ITEMS, boardMismatch } from '../src/types/board.schema.ts';
import { attemptSuffix, withRetry } from './gas-retry.mjs';

const FRONTEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// One deadline per request. Apps Script over quota *queues* requests instead
// of failing fast, and a queued probe must not hold a scheduled job open.
// The two GAS checks retry that deadline (`gas-retry.mjs`), because a single
// timeout or cold-start 404 is a blip, not an outage.
const TIMEOUT_MS = 20_000;
// Two 4-hourly refresh cycles plus the crawl: one missed run is routine and
// self-heals, two in a row is a pipeline that stopped.
const MAX_AGE_MS = 8 * 60 * 60 * 1000;
// A `generated_at` ahead of this clock is corrupt, not fresh; the allowance
// covers ordinary clock skew between the runner and Google.
const MAX_SKEW_MS = 5 * 60 * 1000;
const EXCERPT_CHARS = 500;

const PAGES_URL = withTrailingSlash(process.env.PAGES_URL || 'https://sean1093.github.io/VeggieRadar/');
// `/exec/` is a different Apps Script path from `/exec`, so a dispatch input
// pasted with a trailing slash must not turn the probe into a false alarm.
const API_BASE_URL = (process.env.API_BASE_URL || viteApiBaseUrl()).replace(/\/+$/, '');
const MIRROR_URL = process.env.MIRROR_URL || `${PAGES_URL}data/board.json`;
const OUT = process.env.OUT || 'probe-result.json';

function withTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Parses a body that must be a JSON object. `null`, a number or an array are
 * valid JSON and would pass `JSON.parse`, then throw on the first property
 * read — and an exception here aborts the probe before it writes its result,
 * which the workflow deliberately treats as a broken watchdog rather than as
 * a broken backend. Returns `{ value }` or `{ problem }`.
 */
function parseObject(body) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return { problem: 'non-JSON body' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { problem: `JSON body is ${Array.isArray(value) ? 'an array' : String(value)}, not an object` };
  }
  return { value };
}

/**
 * The deployed backend URL, read from the committed `frontend/.env` so the
 * workflow needs no secret: `/exec` is public by construction — the browser
 * calls it, and Vite inlines it into the bundle (README §7).
 */
function viteApiBaseUrl() {
  try {
    const env = readFileSync(resolve(FRONTEND_DIR, '.env'), 'utf8');
    const match = env.match(/^\s*VITE_API_BASE_URL\s*=\s*(\S+)\s*$/m);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

/** One request with the per-check deadline. Never throws: a dead host is data. */
async function get(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'VeggieRadar-prod-probe' },
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    // A deadline surfaces as TimeoutError, DNS/TLS failures as TypeError.
    return { status: 0, body: '', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/**
 * The same request, but tolerant of Apps Script's two documented blips: a
 * cold-start 404 and a queued request that times out. See `gas-retry.mjs` —
 * one attempt per GAS check is what turned two cold starts into two
 * self-closing prod-alert issues. Contract failures are never retried.
 */
const getGas = (url) => withRetry(get, url);

const ok = (name, detail) => ({ name, status: 'ok', detail });
const skipped = (name, detail) => ({ name, status: 'skipped', detail });
const failed = (name, category, detail, body = '') => ({
  name,
  status: 'failed',
  category,
  detail,
  excerpt: body.trim().slice(0, EXCERPT_CHARS),
});

const hours = (ms) => (ms / 3_600_000).toFixed(1);

/** Milliseconds since the backend last crawled, or null when unknowable. */
function ageMs(generatedAt) {
  const at = Date.parse(generatedAt || '');
  return Number.isNaN(at) ? null : Date.now() - at;
}

/**
 * The two things a board must satisfy wherever it is served from: it matches
 * the contract, and it was crawled recently. Returns null when both hold.
 */
function boardProblem(board) {
  const mismatch = boardMismatch(board);
  if (mismatch) {
    return { kind: 'schema', detail: `schema: ${mismatch.path || '(root)'} — ${mismatch.message}` };
  }
  const age = ageMs(board.generated_at);
  if (age === null) return { kind: 'stale', detail: 'generated_at missing or unparsable' };
  if (age < -MAX_SKEW_MS) {
    return { kind: 'stale', detail: `generated_at is ${hours(-age)} h in the future — clock or payload corrupt` };
  }
  if (age > MAX_AGE_MS) {
    return { kind: 'stale', detail: `crawled ${hours(age)} h ago, limit ${hours(MAX_AGE_MS)} h` };
  }
  return null;
}

async function checkPages() {
  const name = 'pages';
  const res = await get(PAGES_URL);
  if (res.error) return failed(name, 'pages_down', `request failed: ${res.error}`);
  if (res.status !== 200) return failed(name, 'pages_down', `HTTP ${res.status}`, res.body);

  const title = res.body.match(/<title>([^<]*)<\/title>/i);
  if (!title || !title[1].includes('今日菜價')) {
    return failed(name, 'pages_down', `<title> lost 今日菜價: ${title ? title[1] : '(no title)'}`, res.body);
  }
  // A Pages deploy that published the wrong directory still serves a
  // plausible shell; the module script is what makes it an app rather than an
  // empty div, so its absence is a silent white screen for every visitor.
  if (!/<script[^>]+type="module"/i.test(res.body)) {
    return failed(name, 'pages_down', 'no <script type="module"> — bundle missing', res.body);
  }
  return ok(name, 'HTTP 200, title and module bundle present');
}

async function checkMirror() {
  const name = 'mirror';
  const res = await get(MIRROR_URL);
  if (res.error) return failed(name, 'mirror_stale', `request failed: ${res.error}`);
  // A deploy that could obtain neither a fresh board nor the previously
  // published mirror ships without one on purpose (README §2): absent is a
  // degraded state, not a broken one, and `gas_board` below covers the
  // visitors it sends to the backend. Failing here would hold the alert issue
  // permanently open and train its reader to ignore the one alert that matters.
  if (res.status === 404) return skipped(name, 'no mirror published');
  if (res.status !== 200) return failed(name, 'mirror_stale', `HTTP ${res.status}`, res.body);

  const parsed = parseObject(res.body);
  if (parsed.problem) return failed(name, 'mirror_stale', parsed.problem, res.body);
  const board = parsed.value;
  const problem = boardProblem(board);
  if (problem) return failed(name, 'mirror_stale', problem.detail, res.body);
  return ok(name, `${board.count} items, crawled ${hours(ageMs(board.generated_at))} h ago`);
}

async function checkGasBoard() {
  const name = 'gas_board';
  if (!API_BASE_URL) return failed(name, 'gas_error', 'no API base URL: set API_BASE_URL or VITE_API_BASE_URL');
  const res = await getGas(`${API_BASE_URL}?action=board`);
  if (res.error) return failed(name, 'gas_error', `request failed${attemptSuffix(res)}: ${res.error}`);
  if (res.status !== 200) return failed(name, 'gas_error', `HTTP ${res.status}${attemptSuffix(res)}`, res.body);

  // Apps Script answers 200 with an HTML page for platform-level failures
  // (over quota, a deploy that never re-consented to its scopes), so the
  // body is the only thing that tells a healthy backend from a dead one.
  const parsed = parseObject(res.body);
  if (parsed.problem) return failed(name, 'gas_error', `${parsed.problem} — GAS platform error page?`, res.body);
  const board = parsed.value;
  if (board.error) return failed(name, 'gas_error', `backend error: ${board.error}`, res.body);

  const problem = boardProblem(board);
  if (problem) return failed(name, problem.kind === 'schema' ? 'gas_error' : 'gas_stale', problem.detail, res.body);
  if (board.stale !== false) {
    return failed(name, 'gas_stale', `stale: ${JSON.stringify(board.stale)} — a rebuild is queued`, res.body);
  }
  // A throttled MOA batch used to drop a whole slice of the board without any
  // error, which reads as "healthy" on every HTTP-level check there is.
  if (!(board.count >= BOARD_HEALTHY_ITEMS)) {
    return failed(name, 'gas_stale', `count ${board.count} < ${BOARD_HEALTHY_ITEMS}`, res.body);
  }
  return ok(name, `${board.count} items, crawled ${hours(ageMs(board.generated_at))} h ago, stale=false`);
}

/**
 * `?action=diag` covers what the board alone cannot show: whether anything is
 * still scheduled to refresh it, whether the backend already knows it is
 * broken, and whether the baseline history is deep enough for §5's signals.
 * One request, one check per condition, so the alert names the actual fault.
 */
async function checkDiag() {
  const unavailable = (reachCheck) => [
    reachCheck,
    skipped('gas_trigger', 'diag unavailable'),
    skipped('gas_incident', 'diag unavailable'),
    skipped('gas_history', 'diag unavailable'),
  ];

  const name = 'gas_diag';
  if (!API_BASE_URL) {
    return unavailable(failed(name, 'gas_error', 'no API base URL: set API_BASE_URL or VITE_API_BASE_URL'));
  }
  const res = await getGas(`${API_BASE_URL}?action=diag`);
  if (res.error) return unavailable(failed(name, 'gas_error', `request failed${attemptSuffix(res)}: ${res.error}`));
  if (res.status !== 200) {
    return unavailable(failed(name, 'gas_error', `HTTP ${res.status}${attemptSuffix(res)}`, res.body));
  }

  const parsed = parseObject(res.body);
  if (parsed.problem) {
    return unavailable(failed(name, 'gas_error', `${parsed.problem} — GAS platform error page?`, res.body));
  }
  const diag = parsed.value;
  // `alert` / `history` are objects by contract; anything else is read as
  // "unknown" and reported by the condition checks below, never thrown on.
  const alert = diag.alert && typeof diag.alert === 'object' ? diag.alert : {};
  const history = diag.history && typeof diag.history === 'object' ? diag.history : {};

  const triggers = Array.isArray(diag.triggers) ? diag.triggers : [];
  const incidentOpen = alert.incident_open;
  const historyItems = history.items;

  return [
    ok(name, 'HTTP 200, JSON'),
    triggers.includes('refreshBoardCache')
      ? ok('gas_trigger', 'refreshBoardCache installed')
      : failed(
          'gas_trigger',
          'trigger_missing',
          `triggers ${JSON.stringify(triggers)} — run installDailyTrigger() in the Apps Script editor`,
          res.body,
        ),
    incidentOpen === false
      ? ok('gas_incident', 'no open incident')
      : failed('gas_incident', 'incident_open', `alert.incident_open: ${JSON.stringify(incidentOpen)}`, res.body),
    historyItems >= BOARD_HEALTHY_ITEMS
      ? ok('gas_history', `${historyItems} items carry price history`)
      : failed(
          'gas_history',
          'history_thin',
          `history.items ${JSON.stringify(historyItems)} < ${BOARD_HEALTHY_ITEMS} — baselines stop publishing`,
          res.body,
        ),
  ];
}

const STATUS_ICON = { ok: '✅', failed: '❌', skipped: '⏭️' };

/** Detail text inside a table cell: a pipe or a newline would break the row. */
const cell = (text) => (text || '—').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

function renderSummary(checks, checkedAt) {
  const lines = [
    `**VeggieRadar production probe** — ${checkedAt}`,
    '',
    `Pages \`${PAGES_URL}\` · API \`${API_BASE_URL || '(unset)'}\` · mirror \`${MIRROR_URL}\``,
    '',
    '| Check | Status | Category | Detail |',
    '| --- | --- | --- | --- |',
    ...checks.map((c) => `| ${c.name} | ${STATUS_ICON[c.status]} ${c.status} | ${c.category || '—'} | ${cell(c.detail)} |`),
  ];
  for (const failure of checks.filter((c) => c.status === 'failed' && c.excerpt)) {
    // Fenced with four backticks so an HTML error page containing a code fence
    // cannot break out of the block.
    lines.push(
      '',
      `<details><summary>${failure.name} — response body (first ${EXCERPT_CHARS} chars)</summary>`,
      '',
      '````',
      failure.excerpt,
      '````',
      '',
      '</details>',
    );
  }
  return lines.join('\n');
}

const [pages, mirror, board, diag] = await Promise.all([
  checkPages(),
  checkMirror(),
  checkGasBoard(),
  checkDiag(),
]);
const checks = [pages, mirror, board, ...diag];
const checkedAt = new Date().toISOString();
const summaryMd = renderSummary(checks, checkedAt);

writeFileSync(
  resolve(process.cwd(), OUT),
  `${JSON.stringify(
    {
      ok: checks.every((c) => c.status !== 'failed'),
      checked_at: checkedAt,
      // The body excerpts live in `summary_md` only: the machine-readable
      // checks stay small enough to paste into an issue comment untouched.
      checks: checks.map(({ name, status, category, detail }) => ({ name, status, category, detail })),
      summary_md: summaryMd,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`${summaryMd}\n`);
// Set the code rather than calling process.exit(), which can truncate a piped
// summary mid-write.
process.exitCode = checks.some((c) => c.status === 'failed') ? 1 : 0;
