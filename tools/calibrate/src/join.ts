/**
 * Aligning retail with wholesale.
 *
 * Both sides are 元/台斤 — the retail feeds publish that unit and the wholesale
 * side is converted with the backend's own `CATTY_PER_KG` — so an observation
 * is a plain subtraction and no unit conversion hides in the fit.
 *
 * Two joins, because the feeds have different granularity:
 *
 *   - **Taichung, daily.** retail(date, root) is the mean of every surveyed
 *     stall price for that root that day, across the 14 markets and across the
 *     cultivar columns that share the root (four pineapples, three pears).
 *     Unweighted, because the feed publishes no quantities. It is joined to the
 *     board's own daily island-wide wholesale for the SAME date.
 *   - **Taipei, monthly.** retail(month, root) is the mean of the month's
 *     published items for that root, joined to the mean of the board's daily
 *     wholesale over that month. Averaging the daily board prices (rather than
 *     volume-weighting the whole month) keeps the wholesale side the same kind
 *     of average as the retail side: an average over survey days.
 *
 * A date with no traded wholesale is not an observation — MOA's `休市` rows and
 * sub-`MIN_TRADE_VOLUME` days are dropped upstream, so the fit only ever sees
 * days the board itself would have published a card for.
 */
import { loadBackend, defForRoot } from './backend.ts';
import type { CropDef } from './backend.ts';
import { fetchTaichung, meltTaichung } from './sources/taichung.ts';
import type { RetailQuote } from './sources/taichung.ts';
import { fetchTaipeiResources, fetchTaipeiMonth, unmappedItems } from './sources/taipei.ts';
import { coverWindows, fetchRootRows, dailyWholesale } from './sources/moa.ts';
import type { DateRange } from './sources/moa.ts';

export type SourceName = 'taichung' | 'taipei';

/** One paired retail/wholesale measurement of a crop's markup, in 元/台斤. */
export type Observation = {
  source: SourceName;
  root: string;
  /** ISO date; for the monthly feed, the first of the month. */
  date: string;
  retail: number;
  wholesale: number;
  markup: number;
};

export type JoinReport = {
  observations: Observation[];
  /** Retail feed coverage, for the report's "what did we read" section. */
  taichung: { rows: number; from: string; to: string; roots: number; unmapped: string[] };
  taipei: { months: string[]; scraped: boolean; roots: number; unmapped: string[] };
  moa: { roots: number; windows: number };
  /** Latest month any observation covers — what the generated file is "data through". */
  dataThrough: string;
};

/** Mean of a non-empty numeric array. */
function mean(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Groups quotes into retail means, keyed `root\u0000date`. */
export function retailMeans(quotes: RetailQuote[]): Record<string, number> {
  const buckets: Record<string, number[]> = {};
  for (const quote of quotes) {
    (buckets[`${quote.root}\u0000${quote.date}`] ??= []).push(quote.price);
  }
  const out: Record<string, number> = {};
  for (const [key, prices] of Object.entries(buckets)) out[key] = mean(prices);
  return out;
}

/**
 * One def per root, from the variety hints the retail feeds carry.
 *
 * A root must resolve to a single def or the fit would compare two different
 * wholesale prices against one markup, so disagreeing hints are an error, not
 * a last-one-wins.
 */
export function defsForQuotes(quotes: RetailQuote[]): Record<string, CropDef> {
  const backend = loadBackend();
  const hints: Record<string, string | undefined> = {};
  const seen: Record<string, true> = {};
  for (const quote of quotes) {
    if (seen[quote.root] && hints[quote.root] !== quote.item) {
      throw new Error(`conflicting variety hints for ${quote.root}: ${hints[quote.root]} vs ${quote.item}`);
    }
    seen[quote.root] = true;
    hints[quote.root] = quote.item;
  }
  const out: Record<string, CropDef> = {};
  for (const root of Object.keys(seen)) out[root] = defForRoot(backend, root, hints[root]);
  return out;
}

/** Every calendar day in `month` (`YYYY-MM`), as ISO dates. */
function daysInMonth(month: string): string[] {
  const [year, index] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const out: string[] = [];
  for (let day = 1; day <= days; day += 1) out.push(`${month}-${String(day).padStart(2, '0')}`);
  return out;
}

/**
 * Reads both retail feeds, fetches exactly the MOA windows they need, and
 * returns the paired observations.
 */
export async function buildObservations(log: (line: string) => void): Promise<JoinReport> {
  const backend = loadBackend();

  const taichungRows = await fetchTaichung();
  const taichung = meltTaichung(taichungRows);
  const taichungDates = [...new Set(taichung.quotes.map((q) => q.date))].sort();
  log(`taichung: ${taichungRows.length} rows, ${taichung.quotes.length} quotes, ` +
    `${taichungDates[0]}..${taichungDates[taichungDates.length - 1]}`);
  if (taichung.unmapped.length) log(`taichung: UNMAPPED columns ${taichung.unmapped.join(', ')}`);

  const { resources, scraped } = await fetchTaipeiResources();
  log(`taipei: ${resources.length} monthly resources (${scraped ? 'scraped' : 'from committed fixture'})`);
  const taipeiQuotes: RetailQuote[] = [];
  const taipeiItems: string[] = [];
  for (const resource of resources) {
    const month = await fetchTaipeiMonth(resource);
    taipeiQuotes.push(...month.quotes);
    taipeiItems.push(...month.items);
  }
  const taipeiUnmapped = unmappedItems(taipeiItems);
  log(`taipei: ${taipeiQuotes.length} quotes over ${resources.length} months`);
  if (taipeiUnmapped.length) log(`taipei: UNMAPPED items ${taipeiUnmapped.join(', ')}`);

  const taichungMeans = retailMeans(taichung.quotes);
  const taipeiMeans = retailMeans(taipeiQuotes);
  const defs = defsForQuotes([...taichung.quotes, ...taipeiQuotes]);

  // Only the days a retail quote exists for are worth asking MOA about.
  const needed: Record<string, string[]> = {};
  for (const quote of taichung.quotes) (needed[quote.root] ??= []).push(quote.date);
  for (const quote of taipeiQuotes) (needed[quote.root] ??= []).push(...daysInMonth(quote.date.slice(0, 7)));

  const roots = Object.keys(needed).sort();
  const plans: Record<string, DateRange[]> = {};
  let windowCount = 0;
  for (const root of roots) {
    plans[root] = coverWindows(needed[root], backend.BACKFILL_WINDOW_DAYS);
    windowCount += plans[root].length;
  }
  log(`moa: ${roots.length} roots, ${windowCount} windows of ${backend.BACKFILL_WINDOW_DAYS} days`);

  const observations: Observation[] = [];
  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i];
    const rows = await fetchRootRows(root, plans[root]);
    const wholesale = dailyWholesale(rows, defs[root]);
    const byDate: Record<string, number> = {};
    const byMonth: Record<string, number[]> = {};
    for (const day of wholesale) {
      byDate[day.date] = day.catty;
      (byMonth[day.date.slice(0, 7)] ??= []).push(day.catty);
    }

    for (const date of taichungDates) {
      const retail = taichungMeans[`${root}\u0000${date}`];
      const wholesaleCatty = byDate[date];
      if (retail === undefined || wholesaleCatty === undefined) continue;
      observations.push({ source: 'taichung', root, date, retail, wholesale: wholesaleCatty, markup: retail - wholesaleCatty });
    }
    for (const resource of resources) {
      const retail = taipeiMeans[`${root}\u0000${resource.month}-01`];
      const monthly = byMonth[resource.month];
      if (retail === undefined || !monthly) continue;
      const wholesaleCatty = mean(monthly);
      observations.push({
        source: 'taipei', root, date: `${resource.month}-01`,
        retail, wholesale: wholesaleCatty, markup: retail - wholesaleCatty,
      });
    }
    log(`moa: [${i + 1}/${roots.length}] ${root} — ${rows.length} rows, ${wholesale.length} traded days`);
  }

  observations.sort((a, b) => a.root.localeCompare(b.root) || a.date.localeCompare(b.date) || a.source.localeCompare(b.source));
  const months = observations.map((o) => o.date.slice(0, 7)).sort();

  return {
    observations,
    taichung: {
      rows: taichungRows.length,
      from: taichungDates[0],
      to: taichungDates[taichungDates.length - 1],
      roots: new Set(taichung.quotes.map((q) => q.root)).size,
      unmapped: taichung.unmapped,
    },
    taipei: {
      months: resources.map((r) => r.month).sort(),
      scraped,
      roots: new Set(taipeiQuotes.map((q) => q.root)).size,
      unmapped: taipeiUnmapped,
    },
    moa: { roots: roots.length, windows: windowCount },
    dataThrough: months[months.length - 1],
  };
}
