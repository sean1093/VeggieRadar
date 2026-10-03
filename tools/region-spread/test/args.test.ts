/**
 * Argument parsing, which decides what the run measures. Every `--days` case
 * here got past the old `isFinite` test: a fraction silently widened the
 * window, and an enormous value hung the run inside `windows()` rather than
 * failing.
 */
import { describe, it, expect } from 'vitest';
import { parseArgs, MAX_DAYS } from '../src/args.ts';

describe('--days', () => {
  it('takes a whole number of days, up to and including the ceiling', () => {
    expect(parseArgs(['--days', '60'])).toEqual({ days: 60, roots: [] });
    expect(parseArgs(['--days', String(MAX_DAYS)])).toEqual({ days: MAX_DAYS, roots: [] });
    expect(parseArgs(['--days', '2'])).toEqual({ days: 2, roots: [] });
    expect(parseArgs([])).toEqual({ days: 30, roots: [] });
  });

  it('says the value is missing when it is, rather than complaining about its range', () => {
    // A range complaint about a value nobody supplied sends the reader looking
    // for one they did not write.
    expect(() => parseArgs(['--days'])).toThrow(/needs a number of days/);
    // `Number('')` is 0, which would otherwise be reported as out of range.
    expect(() => parseArgs(['--days', ''])).toThrow(/needs a number of days/);
    expect(() => parseArgs(['--days', '   '])).toThrow(/needs a number of days/);
    // The quiet one: the next flag read as the value. `Number('--root')` is
    // NaN, so this used to surface as a complaint about the range.
    expect(() => parseArgs(['--days', '--root', '甘藍'])).toThrow(/needs a number of days/);
  });

  it('rejects a fractional day, which silently becomes a wider window', () => {
    // `--days 2.5` passed `isFinite`, and `addDays(to, -1.5)` lands two days
    // back, so the run measured and cached 3 days under a 2.5-day request.
    expect(() => parseArgs(['--days', '2.5'])).toThrow(/whole number/);
  });

  it('rejects a window that is not a window', () => {
    expect(() => parseArgs(['--days', '1'])).toThrow(/between 2/);
    expect(() => parseArgs(['--days', 'soon'])).toThrow(/whole number/);
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
    // `--root ' '` used to be accepted, and cli.ts then reported an unmatched
    // root whose name was invisible whitespace.
    expect(() => parseArgs(['--root', ' '])).toThrow(/needs a MOA root/);
    // And `--root --days 60` took `--days` as a crop, then blamed `60`.
    expect(() => parseArgs(['--root', '--days', '60'])).toThrow(/needs a MOA root/);
  });

  it('trims a root, so a stray space cannot make it unmatchable', () => {
    expect(parseArgs(['--root', ' 甘藍 '])).toEqual({ days: 30, roots: ['甘藍'] });
  });

  it('keeps a repeated root once, so it cannot double in the report filename', () => {
    expect(parseArgs(['--root', '甘藍', '--root', '甘藍'])).toEqual({ days: 30, roots: ['甘藍'] });
    expect(parseArgs(['--root', '甘藍', '--root', '蕹菜'])).toEqual({ days: 30, roots: ['甘藍', '蕹菜'] });
  });

  it('refuses an argument it does not understand', () => {
    expect(() => parseArgs(['--roots', '甘藍'])).toThrow(/unknown argument/);
  });
});
