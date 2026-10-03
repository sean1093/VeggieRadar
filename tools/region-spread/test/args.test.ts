/**
 * Argument parsing, which decides what the run measures and what it is filed
 * under. Both checks here are about a value that used to be ACCEPTED and then
 * quietly meant something else than it said.
 */
import { describe, it, expect } from 'vitest';
import { parseArgs, MAX_DAYS } from '../src/args.ts';

describe('--days', () => {
  it('takes a whole number of days', () => {
    expect(parseArgs(['--days', '60'])).toEqual({ days: 60, roots: [] });
    expect(parseArgs([])).toEqual({ days: 30, roots: [] });
  });

  it('rejects a fractional day, which addDays would silently truncate', () => {
    // `--days 2.5` passed `isFinite`, and `addDays(to, -1.5)` truncates: the
    // run measured and cached a 3-day window under a filename claiming 2.5.
    expect(() => parseArgs(['--days', '2.5'])).toThrow(/whole number/);
  });

  it('rejects a window that is not a window', () => {
    expect(() => parseArgs(['--days', '1'])).toThrow(/between 2/);
    expect(() => parseArgs(['--days', 'soon'])).toThrow(/whole number/);
    // Past the ceiling `addDays` throws `Invalid time value`, which tells the
    // caller nothing about what they got wrong.
    expect(() => parseArgs(['--days', String(MAX_DAYS + 1)])).toThrow(new RegExp(`${MAX_DAYS}`));
    expect(() => parseArgs(['--days', '1e21'])).toThrow(new RegExp(`${MAX_DAYS}`));
  });
});

describe('--root', () => {
  it('collects every value, so several roots can be measured together', () => {
    expect(parseArgs(['--root', '甘藍', '--root', '蕹菜'])).toEqual({ days: 30, roots: ['甘藍', '蕹菜'] });
  });

  it('refuses a flag with no value, rather than measuring the whole board', () => {
    expect(() => parseArgs(['--root'])).toThrow(/needs a MOA root/);
  });

  it('refuses an argument it does not understand', () => {
    expect(() => parseArgs(['--roots', '甘藍'])).toThrow(/unknown argument/);
  });
});
