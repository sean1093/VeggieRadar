/**
 * `prod-probe.mjs` end to end, against a stand-in for production.
 *
 * The verdict rules have their own tests (`probe-verdict.test.mjs`); what
 * those cannot reach is the *wiring* — the probe is a top-level script, so it
 * cannot be imported, and every rule it applies is only as good as the values
 * `checkMirror` hands to `servingFor`. That call site is exactly where a
 * schema-invalid mirror was briefly softened to `degraded` and would not have
 * paged for the whole backstop window, with the unit test passing throughout because its fixture
 * built `serving` by hand rather than taking what the check produces.
 *
 * So these run the real script as a subprocess and read the result file it
 * writes. Every scenario keeps `?action=board` healthy: a GAS failure would
 * spend the retry budget's 30 s of backoff, and the backend is not what is
 * under test here.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MIRROR_BACKSTOP_MS } from './probe-verdict.mjs';

const HOUR = 60 * 60 * 1000;
// Paths from the working directory, not from `import.meta.url`: vitest
// transforms this file, so the module URL is not a usable file path here.
const FRONTEND = process.cwd();
const PROBE = join(FRONTEND, 'scripts', 'prod-probe.mjs');

const item = (i) => ({
  code: `SP${i}`,
  name: `菜${i}`,
  official_name: `菜${i}`,
  category: '葉菜類',
  avg_price: 30 + i,
  catty_price: 18 + i,
  change_percent: -1.5,
  trade_volume: 1000,
  unit: '公斤',
  markets_count: 5,
});

/** A board the schema accepts, crawled `ageMs` ago. */
const board = (ageMs = HOUR) => ({
  type: 'board',
  date: '2026-09-15',
  roc_date: '115.09.15',
  prev_date: '2026-09-14',
  count: 93,
  items: Array.from({ length: 93 }, (_, i) => item(i)),
  generated_at: new Date(Date.now() - ageMs).toISOString(),
  stale: false,
  age_ms: ageMs,
});

const PAGE = '<html><head><title>今日菜價 · VeggieRadar</title></head>'
  + '<body><script type="module" src="/a.js"></script></body></html>';

/** What `/data/board.json` serves; each test sets it before probing. */
let mirrorBody = JSON.stringify(board());
/** Flipped by the one test that needs `?action=diag` to report a fault. */
let triggersInstalled = true;
/** What `?action=diag` says about the mirror deploy dispatch (#68). */
let mirrorDispatch = null;
let server;
let origin;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/data/board.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(mirrorBody);
      return;
    }
    if (path === '/exec') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        req.url.includes('diag')
          ? JSON.stringify({
              triggers: triggersInstalled ? ['refreshBoardCache'] : [],
              alert: { incident_open: false },
              history: { items: 93 },
              mirror_dispatch: mirrorDispatch,
            })
          : JSON.stringify(board()),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  origin = `http://127.0.0.1:${server.address().port}/`;
});

afterAll(() => new Promise((done) => server.close(done)));

// Reset here rather than at the end of a test body: a failing assertion would
// otherwise leak a broken dispatch into every run after it.
afterEach(() => {
  mirrorDispatch = null;
  triggersInstalled = true;
});

/** Runs the real probe against the stand-in and returns its result file. */
async function probe() {
  const out = join(tmpdir(), `probe-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const code = await new Promise((done) => {
    const child = spawn('node', ['--experimental-strip-types', PROBE], {
      cwd: FRONTEND,
      env: {
        ...process.env,
        PAGES_URL: origin,
        API_BASE_URL: `${origin}exec`,
        OUT: out,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      stdio: 'ignore',
    });
    child.on('close', done);
  });
  try {
    const result = JSON.parse(readFileSync(out, 'utf8'));
      return {
      ...result,
      exitCode: code,
      mirror: result.checks.find((c) => c.name === 'mirror'),
      dispatch: result.checks.find((c) => c.name === 'mirror_dispatch'),
    };
  } finally {
    rmSync(out, { force: true });
  }
}

describe('prod-probe, end to end', () => {
  it('passes clean when both paths serve', async () => {
    mirrorBody = JSON.stringify(board());
    const result = await probe();
    expect(result.mirror.status).toBe('ok');
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('degrades a mirror that is merely late, and does not page', async () => {
    // The 2026-09-16 shape: a mirror past the 8 h bound beside a healthy
    // backend, which every visitor falls through to and gets current prices
    // from (#66).
    mirrorBody = JSON.stringify(board(9 * HOUR));
    const result = await probe();
    expect(result.mirror.status).toBe('degraded');
    expect(result.mirror.category).toBe('mirror_stale');
    expect(result.exitCode).toBe(0);
  });

  it('drops the body excerpt when it softens, since the board is valid', async () => {
    // A green run must not dump 500 characters of correct prices into the job
    // summary and into any open prod-alert comment.
    mirrorBody = JSON.stringify(board(9 * HOUR));
    const result = await probe();
    expect(result.mirror.status).toBe('degraded');
    expect(result.summary_md).not.toMatch(/mirror — response body/);
  });

  it('keeps the excerpt when the mirror really failed', async () => {
    const drifted = board(9 * HOUR);
    drifted.items[0].catty_price = 'NT$16.6';
    mirrorBody = JSON.stringify(drifted);
    const result = await probe();
    expect(result.summary_md).toMatch(/mirror — response body/);
  });

  it('drops the not-paging note when the run pages for something else', async () => {
    // A softened mirror beside a real failure still opens an alert, and a note
    // headed "not paging" inside that issue would be a plain lie.
    mirrorBody = JSON.stringify(board(9 * HOUR));
    triggersInstalled = false;
    const result = await probe();
    expect(result.mirror.status).toBe('degraded');
    expect(result.exitCode).toBe(1);
    expect(result.summary_md).not.toMatch(/not paging/);
  });

  it('pages for a mirror old enough to mean nothing is publishing', async () => {
    mirrorBody = JSON.stringify(board(MIRROR_BACKSTOP_MS + HOUR));
    const result = await probe();
    expect(result.mirror.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  it('pages for schema drift, which shares the category but is not lateness', async () => {
    // The regression this file exists for: `mirror_stale` also covers a
    // contract violation, and softening one would hide it for a day.
    const drifted = board(9 * HOUR);
    drifted.items[0].catty_price = 'NT$16.6';
    mirrorBody = JSON.stringify(drifted);
    const result = await probe();
    expect(result.mirror.status).toBe('failed');
    expect(result.mirror.detail).toMatch(/schema/);
    expect(result.exitCode).toBe(1);
  });

  it('reports the mirror dispatch without paging for it', async () => {
    // The state this ships in: no `GH_DISPATCH_TOKEN`, so the backend records
    // nothing and the cron is the mechanism. Skipped, not failed.
    mirrorBody = JSON.stringify(board());
    const off = await probe();
    expect(off.dispatch.status).toBe('skipped');
    expect(off.exitCode).toBe(0);

    // Configured and working.
    mirrorDispatch = { at: new Date().toISOString(), outcome: 'dispatched', last_ok: new Date().toISOString() };
    const on = await probe();
    expect(on.dispatch.status).toBe('ok');
    expect(on.exitCode).toBe(0);

    // An expired PAT: visible, named, and still not a page — the mirror is on
    // the fallback cron, and the `mirror` check is what bounds its age.
    mirrorDispatch = { at: new Date().toISOString(), outcome: 'rejected 401', last_ok: null };
    const broken = await probe();
    expect(broken.dispatch).toMatchObject({ status: 'degraded', category: 'dispatch_failing' });
    expect(broken.summary_md).toMatch(/GH_DISPATCH_TOKEN/);
    // …and it must not borrow the note that says Apps Script never answered.
    expect(broken.summary_md).not.toMatch(/Apps Script never answered/);
    expect(broken.exitCode).toBe(0);
    expect(broken.ok).toBe(true);
  });

  it('pages for a board that cannot be dated at all', async () => {
    const undated = board(9 * HOUR);
    delete undated.generated_at;
    mirrorBody = JSON.stringify(undated);
    const result = await probe();
    expect(result.mirror.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  it('still calls a board dated inside the skew allowance fresh', async () => {
    // `servingFor` must tolerate the same skew `boardProblem` does, or a
    // backend outage would page while this mirror was covering it.
    mirrorBody = JSON.stringify(board(-60 * 1000));
    const result = await probe();
    expect(result.mirror.status).toBe('ok');
    expect(result.exitCode).toBe(0);
  });
});
