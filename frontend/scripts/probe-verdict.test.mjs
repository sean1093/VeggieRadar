import { describe, expect, it } from 'vitest';
import { applyVerdict, DEGRADED, GAS_UNREACHABLE, reachabilityCategory } from './probe-verdict.mjs';

const HOUR = 60 * 60 * 1000;
// The app's own thresholds, as `prod-probe.mjs` passes them: `useBoard` serves
// the mirror without asking GAS only under BOARD_MAX_AGE_MS (6 h), and a day's
// produce is BOARD_HEALTHY_ITEMS (60) or more.
const THRESHOLDS = { maxAgeMs: 6 * HOUR, healthyItems: 60 };

const check = (name, status, category) => ({ name, status, ...(category ? { category } : {}) });
const servingMirror = (ageMs = 0.9 * HOUR, count = 93) => ({ ...check('mirror', 'ok'), serving: { ageMs, count } });
const mirrorOk = servingMirror();
const gasDown = check('gas_board', 'failed', GAS_UNREACHABLE);

const verdict = (checks) => applyVerdict(checks, THRESHOLDS);
/** What the workflow asks of the result to decide whether to page. */
const pages = (checks) => checks.some((c) => c.status === 'failed');
const statusOf = (checks, name) => checks.find((c) => c.name === name).status;

describe('applyVerdict — the mirror is carrying visitors', () => {
  it('does not page for an unreachable backend while visitors get a fresh board', () => {
    // 2026-09-15: both GAS checks 404ed for over a minute, the mirror was
    // 0.9 h old, and the probe opened #61 — which the next run closed again.
    const out = verdict([
      check('pages', 'ok'),
      mirrorOk,
      gasDown,
      check('gas_diag', 'failed', GAS_UNREACHABLE),
      check('gas_trigger', 'skipped'),
    ]);
    expect(statusOf(out, 'gas_board')).toBe(DEGRADED);
    expect(statusOf(out, 'gas_diag')).toBe(DEGRADED);
    expect(pages(out)).toBe(false);
  });

  it('keeps the category, so the summary still names what went wrong', () => {
    const [, , gas] = verdict([check('pages', 'ok'), mirrorOk, gasDown]);
    expect(gas.category).toBe(GAS_UNREACHABLE);
  });

  it('leaves healthy and skipped checks untouched', () => {
    const input = [check('pages', 'ok'), mirrorOk, check('gas_history', 'skipped')];
    expect(verdict(input)).toEqual(input);
  });

  it('still pages for a backend that answered, and answered wrongly', () => {
    // `gas_error` and `gas_stale` mean something served a response: a platform
    // HTML page, `board.error`, schema drift, a half-crawled board. Nothing
    // about a working mirror makes those self-healing.
    const out = verdict([
      mirrorOk,
      check('gas_board', 'failed', 'gas_error'),
      check('gas_diag', 'failed', 'gas_stale'),
      check('gas_trigger', 'failed', 'trigger_missing'),
      check('gas_incident', 'failed', 'incident_open'),
    ]);
    expect(out.filter((c) => c.status === 'failed')).toHaveLength(4);
    expect(pages(out)).toBe(true);
  });

  it('pages for everything else that broke in the same run', () => {
    const out = verdict([check('pages', 'failed', 'pages_down'), mirrorOk, gasDown]);
    expect(statusOf(out, 'pages')).toBe('failed');
    expect(statusOf(out, 'gas_board')).toBe(DEGRADED);
    expect(pages(out)).toBe(true);
  });
});

describe('applyVerdict — the mirror is not carrying visitors', () => {
  it('pages when no mirror is published: GAS is the only path a visitor has', () => {
    const out = verdict([check('pages', 'ok'), check('mirror', 'skipped'), gasDown]);
    expect(statusOf(out, 'gas_board')).toBe('failed');
    expect(pages(out)).toBe(true);
  });

  it('pages when the mirror is stale: both ways of getting prices are gone', () => {
    const out = verdict([check('pages', 'ok'), check('mirror', 'failed', 'mirror_stale'), gasDown]);
    expect(statusOf(out, 'gas_board')).toBe('failed');
    expect(pages(out)).toBe(true);
  });

  it('pages once the mirror is too old for the app to serve without GAS', () => {
    // Still inside the probe's own 8 h bound, so the `mirror` check passes.
    // But `useBoard` stops short-circuiting at 6 h, so every visitor now falls
    // through to a backend that is not answering and sees the
    // 「目前連不上伺服器」 banner. The deploy cannot refresh the mirror while GAS
    // is down, so this band is exactly where a real outage lands.
    const out = verdict([check('pages', 'ok'), servingMirror(7 * HOUR), gasDown]);
    expect(statusOf(out, 'gas_board')).toBe('failed');
    expect(pages(out)).toBe(true);
  });

  it('still softens a mirror just inside the app’s bound', () => {
    const out = verdict([check('pages', 'ok'), servingMirror(5.9 * HOUR), gasDown]);
    expect(statusOf(out, 'gas_board')).toBe(DEGRADED);
  });

  it('pages when the mirror is fresh but only half a board', () => {
    // A throttled MOA batch. `gas_board`'s count guard normally catches it,
    // and during an outage that check never gets a body to measure.
    const out = verdict([check('pages', 'ok'), servingMirror(0.5 * HOUR, 35), gasDown]);
    expect(statusOf(out, 'gas_board')).toBe('failed');
    expect(pages(out)).toBe(true);
  });

  it('pages when the mirror check passed without saying what it served', () => {
    const out = verdict([check('pages', 'ok'), check('mirror', 'ok'), gasDown]);
    expect(statusOf(out, 'gas_board')).toBe('failed');
  });

  it('is not fooled by a mirror check that never ran', () => {
    const out = verdict([check('pages', 'ok'), gasDown]);
    expect(statusOf(out, 'gas_board')).toBe('failed');
  });
});

describe('reachabilityCategory — what "no usable answer" was', () => {
  it('calls the symptoms that never reached doGet unreachable', () => {
    expect(reachabilityCategory({ status: 404, body: '<!DOCTYPE html>' })).toBe(GAS_UNREACHABLE);
    expect(reachabilityCategory({ status: 503, body: '' })).toBe(GAS_UNREACHABLE);
    expect(reachabilityCategory({ status: 0, body: '', error: 'TimeoutError: …' })).toBe(GAS_UNREACHABLE);
  });

  it('pages for anything the backend itself served, however useless', () => {
    // A deployment whose access was narrowed to its owner answers 403 to every
    // visitor; an empty 200 is `doGet` returning nothing. Softening either to
    // a summary row would leave a real outage unreported for up to 8 h.
    expect(reachabilityCategory({ status: 403, body: '' })).toBe('gas_error');
    expect(reachabilityCategory({ status: 302, body: '' })).toBe('gas_error');
    expect(reachabilityCategory({ status: 200, body: '' })).toBe('gas_error');
  });

  it('survives a response the probe never got to make', () => {
    expect(reachabilityCategory(undefined)).toBe('gas_error');
  });
});
