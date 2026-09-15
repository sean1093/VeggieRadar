import { describe, expect, it } from 'vitest';
import { applyVerdict, DEGRADED, GAS_UNREACHABLE } from './probe-verdict.mjs';

const check = (name, status, category) => ({ name, status, ...(category ? { category } : {}) });
const mirrorOk = check('mirror', 'ok');
const gasDown = check('gas_board', 'failed', GAS_UNREACHABLE);

/** What the workflow asks of the result to decide whether to page. */
const pages = (checks) => checks.some((c) => c.status === 'failed');
const statusOf = (checks, name) => checks.find((c) => c.name === name).status;

describe('applyVerdict — the mirror is serving', () => {
  it('does not page for an unreachable backend while visitors get a fresh board', () => {
    // 2026-09-15: both GAS checks 404ed for over a minute, the mirror was
    // 0.9 h old, and the probe opened #61 — which the next run closed again.
    const out = applyVerdict([
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
    const [, , gas] = applyVerdict([check('pages', 'ok'), mirrorOk, gasDown]);
    expect(gas.category).toBe(GAS_UNREACHABLE);
  });

  it('leaves healthy and skipped checks untouched', () => {
    const input = [check('pages', 'ok'), mirrorOk, check('gas_history', 'skipped')];
    expect(applyVerdict(input)).toEqual(input);
  });

  it('still pages for a backend that answered, and answered wrongly', () => {
    // `gas_error` and `gas_stale` mean something served a response: a platform
    // HTML page, `board.error`, schema drift, a half-crawled board. Nothing
    // about a working mirror makes those self-healing.
    const out = applyVerdict([
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
    const out = applyVerdict([check('pages', 'failed', 'pages_down'), mirrorOk, gasDown]);
    expect(statusOf(out, 'pages')).toBe('failed');
    expect(statusOf(out, 'gas_board')).toBe(DEGRADED);
    expect(pages(out)).toBe(true);
  });
});

describe('applyVerdict — the mirror is not serving', () => {
  it('pages when no mirror is published: GAS is the only path a visitor has', () => {
    const out = applyVerdict([check('pages', 'ok'), check('mirror', 'skipped', undefined), gasDown]);
    expect(statusOf(out, 'gas_board')).toBe('failed');
    expect(pages(out)).toBe(true);
  });

  it('pages when the mirror is stale: both ways of getting prices are gone', () => {
    const out = applyVerdict([check('pages', 'ok'), check('mirror', 'failed', 'mirror_stale'), gasDown]);
    expect(statusOf(out, 'gas_board')).toBe('failed');
    expect(pages(out)).toBe(true);
  });

  it('is not fooled by a mirror check that never ran', () => {
    const out = applyVerdict([check('pages', 'ok'), gasDown]);
    expect(statusOf(out, 'gas_board')).toBe('failed');
  });
});
