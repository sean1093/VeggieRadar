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

  it('rejects a fractional day, which silently becomes a wider window', () => {
    // `--days 2.5` passed `isFinite`, and `addDays(to, -1.5)` lands two days
    // back, so the run measured and cached 3 days under a 2.5-day request.
    expect(() => parseArgs(['--days', '2.5'])).toThrow(/whole number/);
  });

  it('rejects a window that is not a window', () => {
    expect(() => parseArgs(['--days', '1'])).toThrow(/between 2/);
    expect(() => parseArgs(['--days', 'soon'])).toThrow(/whole number/);
    // Nothing downstream objects to a huge window: `addDays` keeps counting
    // rather than throwing, so without this bound `--days 1000000` resolves
    // to a window starting in the year −712 and crawls for it.
    expect(() => parseArgs(['--days', String(MAX_DAYS + 1)])).toThrow(new RegExp(`${MAX_DAYS}`));
    expect(() => parseArgs(['--days', '1000000'])).toThrow(new RegExp(`${MAX_DAYS}`));
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
