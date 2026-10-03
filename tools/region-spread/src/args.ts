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

/**
 * The value belonging to `flag`, or a refusal naming the flag.
 *
 * One helper for every flag, because the three ways a value goes missing look
 * nothing alike on the command line and identical afterwards: omitted at the
 * end, empty or blank, or swallowed from the next flag. Left to each branch,
 * the last one is the quiet case — `--days --root 甘藍` read `--root` as the
 * number of days and then complained about a range, and `--root --days 60`
 * took `--days` as a crop and blamed `60`. A value is refused when it looks
 * like a flag rather than when it fails to parse, so the message is about the
 * argument the caller actually got wrong.
 */
function valueFor(argv: string[], index: number, flag: string, expected: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error(`${flag} needs ${expected}`);
  }
  return value.trim();
}

export function parseArgs(argv: string[]): { days: number; roots: string[] } {
  let days = DEFAULT_DAYS;
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') {
      days = Number(valueFor(argv, i, '--days', 'a number of days'));
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
      const root = valueFor(argv, i, '--root', 'a MOA root name');
      // Named twice is named once: a repeat would otherwise ride along into
      // the report's filename (`..._甘藍+甘藍.md`) while changing no number.
      if (!roots.includes(root)) roots.push(root);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return { days, roots };
}
