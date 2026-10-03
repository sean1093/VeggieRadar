/**
 * The command line, in its own module so it can be tested: `cli.ts` runs
 * `main()` on import, and a test that imported it would launch a measurement.
 *
 * Both bounds here guard a value that used to be ACCEPTED and then quietly
 * meant something other than what it said.
 */

export const DEFAULT_DAYS = 30;
/**
 * The same 400 days `tools/catalog` crawls — the repo's own answer to how far
 * back the feed is worth asking about.
 *
 * A ceiling is needed because nothing downstream objects to the absence of
 * one: `addDays` does not throw on a huge offset, it just keeps counting, so
 * `--days 1000000` resolves to a window starting in the year −712 and sends
 * roughly 80,000 requests looking for it. The bound turns that into an answer
 * about the argument instead.
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
      days = Number(argv[i + 1]);
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
