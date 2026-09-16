import { describe, expect, it } from 'vitest';
import { CLIENT_BOARD_TIMEOUT_MS } from '../../scripts/probe-verdict.mjs';
import { BOARD_TIMEOUT_MS } from './api';

/**
 * The production probe decides whether a stale mirror is worth paging for by
 * asking whether the backend answered fast enough that a visitor would have
 * seen it. It cannot import this module — that would drag the app into a
 * dependency-free Node script — so it keeps its own copy of the deadline, and
 * this is what stops the two from drifting apart in the direction that matters:
 * a probe copy larger than the real one would call visitors served while every
 * one of them timed out.
 */
describe('the probe’s copy of the client board deadline', () => {
  it('is exactly what `fetchBoard` gives one attempt', () => {
    expect(CLIENT_BOARD_TIMEOUT_MS).toBe(BOARD_TIMEOUT_MS);
  });
});
