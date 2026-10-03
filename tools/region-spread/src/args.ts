/**
 * The command line, in its own module so it can be tested: `cli.ts` runs
 * `main()` on import, and a test that imported it would launch a measurement.
 *
 * Both bounds here guard a value that used to be ACCEPTED and then quietly
 * meant something other than what it said.
 */

export const DEFAULT_DAYS = 30;
/** The crop crawler's window (`tools/catalog`); past a year the feed is thin anyway. */
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
      // Whole days, bounded. `2.5` used to pass `isFinite`, and `addDays`
      // truncates the fractional offset — so it measured and cached a 3-day
      // window under a filename claiming 2.5. The ceiling is the crop
      // crawler's own window; past it `addDays` throws `Invalid time value`,
      // which says nothing about what the caller got wrong.
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
