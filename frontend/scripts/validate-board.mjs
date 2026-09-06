/**
 * Gate on the static board mirror before the Pages deploy publishes it
 * (README §2, §8).
 *
 * The mirror is a *file*: once written it keeps serving whatever was in it,
 * with its own `stale: false` frozen inside, until the next scheduled run
 * replaces it. A bad fetch is therefore not a bad request that self-heals in
 * four hours — it is up to four hours of wrong or empty prices in front of
 * every visitor, and it would also overwrite the last good mirror on the way.
 * So the payload is held to the same contract and the same freshness bound the
 * app and the production probe use, and a rejected board leaves the previously
 * published mirror in place.
 *
 * Run from `frontend/`:
 *   node --experimental-strip-types scripts/validate-board.mjs /tmp/board.json
 *
 * The flag is required on Node 22.6–22.17 and a harmless no-op from 22.18 on.
 * It is what lets this dependency-free script import the very TypeScript
 * schema the client validates against, rather than a copy that would drift.
 *
 * Exit 0 prints a one-line summary on stdout; exit 1 prints a one-line reason
 * on stderr, which the workflow quotes in its step summary.
 */
import { readFileSync } from 'node:fs';
import { BOARD_HEALTHY_ITEMS, boardMismatch } from '../src/types/board.schema.ts';

// Two 4-hourly refresh cycles plus the crawl, the same bound `prod-probe.mjs`
// alerts on. The mirror is fetched 20 minutes after a scheduled refresh, so a
// board anywhere near this age means the backend missed a run — freezing that
// into a file would hide a broken pipeline behind a plausible-looking board.
const MAX_AGE_MS = 8 * 60 * 60 * 1000;
// A `generated_at` ahead of this clock is corrupt, not fresh; the allowance
// covers ordinary clock skew between the runner and Google.
const MAX_SKEW_MS = 5 * 60 * 1000;

const hours = (ms) => (ms / 3_600_000).toFixed(1);

/** The first reason this payload must not be published, or null. */
function boardProblem(board) {
  if (board === null || typeof board !== 'object' || Array.isArray(board)) {
    return `JSON body is ${Array.isArray(board) ? 'an array' : String(board)}, not an object`;
  }
  // `doGet` reports its own failures as JSON, which parses perfectly well.
  if (board.error) return `backend error: ${board.error}`;

  // The contract itself, including `type === 'board'` (a `z.literal`) and the
  // type of every item field.
  const mismatch = boardMismatch(board);
  if (mismatch) return `schema: ${mismatch.path || '(root)'} — ${mismatch.message}`;

  if (board.items.length < BOARD_HEALTHY_ITEMS) {
    return `${board.items.length} items < ${BOARD_HEALTHY_ITEMS} — a throttled crawl, not a season`;
  }

  const built = Date.parse(board.generated_at || '');
  if (Number.isNaN(built)) return 'generated_at missing or unparsable';
  const age = Date.now() - built;
  if (age < -MAX_SKEW_MS) return `generated_at is ${hours(-age)} h in the future — clock or payload corrupt`;
  if (age > MAX_AGE_MS) return `crawled ${hours(age)} h ago, limit ${hours(MAX_AGE_MS)} h`;

  // What the schema types but cannot judge: a price has to be positive and a
  // name has to be a name. `change_percent` is re-checked for finiteness
  // because this is the mirror's last gate and the rule belongs with the other
  // two — a contract that later makes the field optional must not silently
  // publish a board whose change column is empty.
  for (const item of board.items) {
    if (!item.name) return `item ${item.code || '(no code)'} has no name`;
    if (!(item.catty_price > 0)) return `${item.name}: catty_price ${JSON.stringify(item.catty_price)}`;
    if (!Number.isFinite(item.change_percent)) {
      return `${item.name}: change_percent ${JSON.stringify(item.change_percent)}`;
    }
  }
  return null;
}

const [file] = process.argv.slice(2);
if (!file) {
  process.stderr.write('usage: validate-board.mjs <board.json>\n');
  process.exitCode = 2;
} else {
  let problem;
  let board;
  try {
    board = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // A missing file, a truncated download and a GAS platform HTML page all
    // land here; the message names which.
    problem = `${file}: ${error.message}`;
  }
  problem ??= boardProblem(board);

  if (problem) {
    process.stderr.write(`board rejected: ${problem}\n`);
    // Set the code rather than calling process.exit(), which can truncate a
    // piped message mid-write.
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `board ok: ${board.items.length} items, traded ${board.date}, crawled ${hours(Date.now() - Date.parse(board.generated_at))} h ago\n`,
    );
  }
}
