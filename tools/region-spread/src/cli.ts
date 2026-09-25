/**
 * `npm run measure` — fetch a window of MOA rows for every board item, split it
 * by region, and write the report that issue #23's first acceptance criterion
 * needs.
 *
 * The run is read-only: it writes a report and a JSON dump under `report/`, and
 * touches nothing in `backend/` or `frontend/`. Deciding whether to build the
 * regional board is a human's job; this only supplies the numbers.
 *
 *   npm run measure                 # the last 30 days
 *   npm run measure -- --days 60
 *   npm run measure -- --root 甘藍 --root 蕹菜
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackend } from './backend.ts';
import type { MoaRow } from './backend.ts';
import { fetchRoot, stats, addDays, localToday, truncatedDates } from './moa.ts';
import { dailySplit, cropStats, marketSightings } from './measure.ts';
import type { CropStats } from './measure.ts';
import { renderReport } from './report.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '../report');

const DEFAULT_DAYS = 30;
/**
 * Wholesale prices publish after market close, so the most recent day is not
 * yet complete. The window ends yesterday for the same reason the board walks
 * back to the latest day with real trades.
 */
const END_OFFSET_DAYS = 1;

function parseArgs(argv: string[]): { days: number; roots: string[] } {
  let days = DEFAULT_DAYS;
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') {
      days = Number(argv[i + 1]);
      if (!Number.isFinite(days) || days < 2) throw new Error('--days needs a number ≥ 2');
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

async function main(): Promise<void> {
  const { days, roots: only } = parseArgs(process.argv.slice(2));
  const backend = loadBackend();

  const to = addDays(localToday(), -END_OFFSET_DAYS);
  const from = addDays(to, -(days - 1));

  // Each `--root` is checked on its own. A run where one name matched and
  // another did not would otherwise fetch part of what was asked for and
  // report it under a filename and a header that both claim the whole — and
  // `甘藍` is the root while `高麗菜` is the display name, so naming the wrong
  // one is the easy mistake, not the exotic one.
  const unmatched = only.filter((root) => !backend.BOARD_ITEMS.some((d) => d.official === root));
  if (unmatched.length) {
    throw new Error(`no board item has the MOA root ${unmatched.join(', ')} (BOARD_ITEMS uses official names: 甘藍, not 高麗菜)`);
  }
  const items = only.length
    ? backend.BOARD_ITEMS.filter((d) => only.includes(d.official))
    : backend.BOARD_ITEMS;

  // One fetch per ROOT, shared by every item defined on it (花椰菜 白/青, 甜椒
  // 青椒/甜椒), because `selectRows` filters the same rows differently per item.
  const wanted = [...new Set(items.map((d) => d.official))];
  console.log(`measuring ${items.length} items (${wanted.length} roots) over ${from} → ${to}`);

  const rowsByRoot = new Map<string, MoaRow[]>();
  for (let i = 0; i < wanted.length; i += 1) {
    const root = wanted[i];
    rowsByRoot.set(root, await fetchRoot(root, from, to));
    process.stdout.write(`\r  fetched ${i + 1}/${wanted.length} roots (${stats.requests} requests)`);
  }
  process.stdout.write('\n');

  const crops: CropStats[] = items.map((def) =>
    cropStats(def, dailySplit(rowsByRoot.get(def.official) ?? [], def, truncatedDates(def.official))),
  );
  const markets = marketSightings(items, rowsByRoot);

  const meta = {
    from,
    to,
    minTradeVolume: backend.MIN_TRADE_VOLUME,
    requests: stats.requests,
    cacheHits: stats.cacheHits,
    retries: stats.retries,
    failures: stats.failures,
    truncated: [...stats.truncated],
    itemsRequested: items.length,
    partial: only.length > 0,
  };

  mkdirSync(REPORT_DIR, { recursive: true });
  // A `--root` run covers part of the board, so it must not land on the full
  // run's filename: the README suggests it for a quick look, and a quick look
  // silently replacing the report a conclusion was drawn from is the kind of
  // loss nobody notices until the numbers are already in an issue.
  const stem = resolve(REPORT_DIR, `${from}_${to}${only.length ? `_${only.join('+')}` : ''}`);
  writeFileSync(`${stem}.md`, `${renderReport(meta, markets, crops)}\n`);
  writeFileSync(`${stem}.json`, `${JSON.stringify({ meta, markets, crops }, null, 2)}\n`);

  const unmapped = markets.filter((m) => m.region === '其他');
  if (unmapped.length) {
    console.log(`\n⚠️  ${unmapped.length} unmapped market(s): ${unmapped.map((m) => m.name).join('、')}`);
    console.log('    add them to REGION_BY_MARKET in src/regions.ts and re-run (the cache makes it free)');
  }
  console.log(`\nwrote ${stem}.md`);
  console.log(`      ${stem}.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
