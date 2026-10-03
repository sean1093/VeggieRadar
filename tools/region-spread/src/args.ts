/**
 * The command line, in its own module so it can be tested: `cli.ts` runs
 * `main()` on import, and a test that imported it would launch a measurement.
 *
 * Each `--days` check is here because the value got past the old `isFinite`
 * test and then went wrong somewhere else: see the notes on `MAX_DAYS` and on
 * the checks themselves.
 */

export const DEFAULT_DAYS = 30;
/**
 * The same 400 days `tools/catalog` crawls — the repo's own answer to how far
 * back the feed is worth asking about.
 *
 * It is a bound on the ARGUMENT, so an over-long window is answered here, by
 * name, rather than somewhere downstream. `addDays` now refuses an offset that
 * leaves the representable range on its own, which is the real guard; this one
 * exists so that `--days 1000000` is a sentence about `--days` instead of a
 * date-arithmetic error from three modules away.
 */
export const MAX_DAYS = 400;
/**
 * Wholesale prices publish after market close, so the most recent day is not
 * yet complete. The window ends yesterday for the same reason the board walks
 * back to the latest day with real trades.
 */
export const END_OFFSET_DAYS = 1;

export function parseArgs(argv: string[]): { days: number; roots: string[] } {
  let days = DEFAULT_DAYS;
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') {
      const value = argv[i + 1];
      // Told apart from an out-of-range value: a range complaint about a value
      // nobody supplied sends the reader looking for one they did not write.
      // An empty argument counts as not supplied — `Number('')` is 0, which
      // would otherwise reach the range check and be reported as one.
      if (value === undefined || value.trim() === '') {
        throw new Error('--days needs a number of days');
      }
      days = Number(value);
      // Whole days. `2.5` used to pass `isFinite` and then mean something
      // else: `addDays` adds the fractional offset to the day of month and
      // the Date truncates after, so `-1.5` lands two days back and a request
      // for 2.5 days measured and cached 3 — the report's 期間 row then states
      // a window the caller never asked for.
      if (!Number.isInteger(days) || days < 2 || days > MAX_DAYS) {
        throw new Error(`--days needs a whole number between 2 and ${MAX_DAYS}`);
      }
      i += 1;
    } else if (argv[i] === '--root') {
      const root = argv[i + 1];
      if (!root) throw new Error('--root needs a MOA root name');
      roots.push(root);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return { days, roots };
}
