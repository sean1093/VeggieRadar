/**
 * MOA wholesale — the same endpoint, URL shape and ROC dates the backend uses.
 *
 * The wholesale side of every observation is produced by the LIVE code path:
 * `cropUrl` builds the URL, `selectRows` filters the crop out of MOA's
 * substring match, `weightedAverage` blends it island-wide and `CATTY_PER_KG`
 * converts to 元/台斤. Nothing here re-implements that arithmetic.
 *
 * MOA truncates one response near 1,000 rows and says so with `Next: true`, so
 * a root is fetched in short windows (the backend's own `BACKFILL_WINDOW_DAYS`)
 * and any window that still truncates is split in half and refetched.
 */
import { cachedText, inBatches } from '../http.ts';
import { loadBackend } from '../backend.ts';
import type { CropDef, MoaRow } from '../backend.ts';

export type DateRange = { from: string; to: string };

/** Island-wide wholesale in 元/台斤 for one crop on one ISO date. */
export type WholesaleDay = { date: string; catty: number; volume: number };

/** ISO date arithmetic in UTC: these are calendar dates, never instants. */
function addDays(iso: string, days: number): string {
  const at = new Date(`${iso}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * The shortest list of ≤ `days`-long closed windows that covers every date in
 * `dates`.
 *
 * Driving the plan off the dates a retail quote actually exists for is what
 * keeps a refit affordable: a citrus root surveyed only from December to March
 * costs a quarter of the requests a year-round cabbage does. Greedy from the
 * oldest date is optimal here — a window that starts on an uncovered date and
 * runs the full length can never be beaten by a later start.
 */
export function coverWindows(dates: string[], days: number): DateRange[] {
  const sorted = [...new Set(dates)].sort();
  const out: DateRange[] = [];
  for (let i = 0; i < sorted.length; ) {
    const from = sorted[i];
    const to = addDays(from, days - 1);
    out.push({ from, to });
    while (i < sorted.length && sorted[i] <= to) i += 1;
  }
  return out;
}

/**
 * Every MOA row for `root` across `plan`'s windows.
 *
 * A window that returns `Next: true` was truncated (MOA keeps the newest rows
 * and drops the oldest), so it is halved and refetched rather than quietly
 * losing the start of the window.
 */
export async function fetchRootRows(root: string, plan: DateRange[]): Promise<MoaRow[]> {
  const backend = loadBackend();
  const pending = [...plan];
  const rows: MoaRow[] = [];

  while (pending.length) {
    const batch = pending.splice(0, pending.length);
    const results = await inBatches(batch, async (window) => {
      const url = backend.cropUrl(root, roc(window.from), roc(window.to));
      const body = await cachedText('moa', url, (text) => text.includes('"RS"'));
      return { window, payload: JSON.parse(body) as { Data?: MoaRow[]; Next?: boolean } };
    });
    for (const { window, payload } of results) {
      const span = spanDays(window);
      if (payload.Next === true && span > 1) {
        const half = Math.ceil(span / 2);
        pending.push({ from: window.from, to: addDays(window.from, half - 1) });
        pending.push({ from: addDays(window.from, half), to: window.to });
        continue;
      }
      rows.push(...(payload.Data ?? []));
    }
  }
  return rows;
}

/** ROC date string for the API, via the backend's own converter. */
function roc(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return loadBackend().dateToROC(new Date(year, month - 1, day));
}

/** Inclusive length of a closed date range, in calendar days. */
function spanDays(range: DateRange): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * Groups rows into the daily island-wide catty price the board would publish:
 * `selectRows` → `weightedAverage` → × `CATTY_PER_KG`. Days whose traded volume
 * is below `MIN_TRADE_VOLUME` are dropped — the board would not show a card for
 * them, so they cannot calibrate one.
 */
export function dailyWholesale(rows: MoaRow[], def: CropDef): WholesaleDay[] {
  const backend = loadBackend();
  const byDate: Record<string, MoaRow[]> = {};
  for (const row of backend.selectRows(rows, def)) {
    const iso = backend.rocToISO(String(row.TransDate ?? ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    (byDate[iso] ??= []).push(row);
  }
  const out: WholesaleDay[] = [];
  for (const [date, dayRows] of Object.entries(byDate)) {
    const blended = backend.weightedAverage(dayRows);
    if (blended.volume < backend.MIN_TRADE_VOLUME || blended.avg <= 0) continue;
    out.push({ date, catty: blended.avg * backend.CATTY_PER_KG, volume: blended.volume });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
