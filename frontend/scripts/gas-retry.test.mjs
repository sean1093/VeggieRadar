import { describe, expect, it, vi } from 'vitest';
import { attemptSuffix, isTransient, withRetry } from './gas-retry.mjs';

/** `get()` in prod-probe.mjs never throws: a dead host comes back as data. */
const res = (status, body = '{}') => ({ status, body });
const dead = (error) => ({ status: 0, body: '', error });

describe('isTransient', () => {
  it('treats a request that never got an answer as transient', () => {
    expect(isTransient(dead('TimeoutError: The operation was aborted due to timeout'))).toBe(true);
    expect(isTransient(dead('TypeError: fetch failed'))).toBe(true);
  });

  it('treats 404 and 5xx as transient — doGet always answers JSON, so neither reached it', () => {
    expect(isTransient(res(404, '<!DOCTYPE html>'))).toBe(true);
    expect(isTransient(res(500))).toBe(true);
    expect(isTransient(res(502))).toBe(true);
    expect(isTransient(res(503))).toBe(true);
  });

  it('does not retry an answer the backend actually served', () => {
    // A 200 carrying a stale board, too few items, or even a platform HTML
    // page is evidence. Retrying would hide a real fault for a minute.
    expect(isTransient(res(200, '{"type":"board","stale":true}'))).toBe(false);
    expect(isTransient(res(200, '<!DOCTYPE html>'))).toBe(false);
    expect(isTransient(res(403))).toBe(false);
    expect(isTransient(res(302))).toBe(false);
  });

  it('is not fooled by a missing response', () => {
    expect(isTransient(undefined)).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});

describe('withRetry', () => {
  const sleep = () => Promise.resolve();

  it('returns a healthy answer on the first attempt without waiting', async () => {
    const get = vi.fn(async () => res(200, '{"type":"board"}'));
    const out = await withRetry(get, 'url', { sleep });
    expect(get).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(200);
    expect(out.attempts).toBe(1);
  });

  it('rides out the cold-start 404 that used to open a prod-alert issue', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(res(404, '<!DOCTYPE html>'))
      .mockResolvedValueOnce(res(200, '{"type":"board"}'));
    const out = await withRetry(get, 'url', { sleep });
    expect(get).toHaveBeenCalledTimes(2);
    expect(out.status).toBe(200);
    expect(out.attempts).toBe(2);
  });

  it('rides out a timeout, the other symptom seen in production', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(dead('TimeoutError: The operation was aborted due to timeout'))
      .mockResolvedValueOnce(res(200, '{"type":"board"}'));
    const out = await withRetry(get, 'url', { sleep });
    expect(out.status).toBe(200);
    expect(out.attempts).toBe(2);
  });

  it('gives up after the last attempt and reports the real symptom, not "gave up"', async () => {
    const get = vi.fn(async () => res(404, '<!DOCTYPE html>'));
    const out = await withRetry(get, 'url', { sleep });
    expect(get).toHaveBeenCalledTimes(3);
    expect(out.status).toBe(404);
    expect(out.body).toBe('<!DOCTYPE html>');
    expect(out.attempts).toBe(3);
  });

  it('never retries a contract failure — that is a finding, not a blip', async () => {
    const get = vi.fn(async () => res(200, '{"type":"board","stale":true}'));
    const out = await withRetry(get, 'url', { sleep });
    expect(get).toHaveBeenCalledTimes(1);
    expect(out.attempts).toBe(1);
  });

  it('backs off between attempts, and only between them', async () => {
    const waits = [];
    const get = vi.fn(async () => res(404));
    await withRetry(get, 'url', { sleep: (ms) => (waits.push(ms), Promise.resolve()) });
    // Two waits for three attempts: nothing is spent after the last one.
    expect(waits).toEqual([2_000, 4_000]);
  });
});

describe('attemptSuffix', () => {
  it('stays silent when the first attempt settled it', () => {
    expect(attemptSuffix({ attempts: 1 })).toBe('');
    expect(attemptSuffix(undefined)).toBe('');
  });

  it('says how hard the probe tried, so the alert distinguishes a blip from an outage', () => {
    expect(attemptSuffix({ attempts: 3 })).toBe(' after 3 attempts');
  });
});
