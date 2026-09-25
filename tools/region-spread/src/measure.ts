/**
 * The measurement itself: MOA rows → what a regional board would actually
 * publish, and how trustworthy each number would be.
 *
 * Issue #23 rests on three claims that have never been measured. This module
 * answers each with a statistic rather than an intuition:
 *
 *   1. **Is there a regional difference worth showing?** The issue estimates
 *      30% for 高麗菜. `spread` is that difference, per crop per day: the gap
 *      between the dearest and cheapest qualifying region as a share of the
 *      nationwide price the board shows today.
 *   2. **Does each region have enough trade to survive the gate?** Splitting
 *      four ways divides a crop's volume four ways, while `MIN_TRADE_VOLUME`
 *      stays where it is. `coverage` is the share of trading days on which a
 *      region would clear it — a region that qualifies on a third of days is a
 *      tab that is usually empty.
 *   3. **Would a regional change-percent be real?** Wholesale markets rest on
 *      fixed weekdays (`tools/catalog/src/build-catalog.ts` builds its whole
 *      sampling stride around it). Nationwide, a closed market is diluted by
 *      twelve others; inside one region it can be half the sample, so a
 *      day-over-day move may be the market mix changing rather than the price.
 *      `mixChurn` counts how often the contributing markets actually change
 *      between consecutive qualifying days, and `changeGap` measures how far
 *      the regional move lands from the nationwide one.
 *
 * Everything the board's own arithmetic decides — which rows belong to an item,
 * how they blend, what clears the gate, the display unit — is delegated to the
 * backend. This module only groups and compares.
 */
import { loadBackend } from './backend.ts';
import type { CropDef, MoaRow } from './backend.ts';
import { regionOf, normalizeMarket, REGIONS } from './regions.ts';
import type { Region } from './regions.ts';

/** A region whose coverage is below this is reported as not viable as a tab. */
export const VIABLE_COVERAGE = 0.8;

/** One region's blended price on one date, in the unit the app displays. */
export type RegionDay = {
  region: Region;
  catty: number;
  volume: number;
  markets: string[];
  /** Clears `MIN_TRADE_VOLUME` — i.e. the board would be willing to show it. */
  qualified: boolean;
};

/** One crop on one date: what the board shows today, and the regional split of it. */
export type CropDay = {
  date: string;
  nationalCatty: number;
  nationalVolume: number;
  nationalMarkets: number;
  regions: RegionDay[];
};

export type RegionStats = {
  region: Region;
  qualifiedDays: number;
  coverage: number;
  medianMarkets: number;
  medianVolume: number;
  /** Signed median of (region − nationwide) / nationwide, in %. The level difference. */
  medianDeviationPct: number;
  p90AbsDeviationPct: number;
  changePairs: number;
  medianGapDays: number;
  /** |regional change% − nationwide change%| over the same date pair. */
  medianChangeGapPct: number;
  p90ChangeGapPct: number;
  mixChurn: number;
  viable: boolean;
};

export type CropStats = {
  name: string;
  official: string;
  category: string;
  days: number;
  volume: number;
  spreadDays: number;
  medianSpreadPct: number;
  p90SpreadPct: number;
  regions: RegionStats[];
  viableRegions: number;
};

/** One market as the feed actually spelled it, with what the table made of it. */
export type MarketSighting = {
  name: string;
  codes: string[];
  region: Region;
  days: number;
  volume: number;
};

/**
 * Splits one board item's rows into the daily national and regional blends.
 *
 * Only days the board itself would publish are kept: `selectRows` decides which
 * rows belong to the item and `MIN_TRADE_VOLUME` decides whether the nationwide
 * card exists at all. A day with no nationwide card cannot have a regional one,
 * and including it would flatter every regional coverage number.
 *
 * `truncated` drops the days MOA cut short. Such a day holds only its newest
 * rows, so some of its markets are missing — and a missing market is precisely
 * a price difference that is not there. Naming those days in the report is not
 * enough: they must not reach a median, a spread, a coverage ratio or a churn
 * count, because nothing downstream could tell them apart from a real one.
 */
export function dailySplit(rows: MoaRow[], def: CropDef, truncated = new Set<string>()): CropDay[] {
  const backend = loadBackend();
  const byDate = new Map<string, MoaRow[]>();
  for (const row of backend.selectRows(rows, def)) {
    const iso = backend.rocToISO(String(row.TransDate ?? ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    if (truncated.has(iso)) continue;
    const bucket = byDate.get(iso);
    if (bucket) bucket.push(row);
    else byDate.set(iso, [row]);
  }

  const out: CropDay[] = [];
  for (const [date, dayRows] of byDate) {
    const national = backend.weightedAverage(dayRows);
    if (national.volume < backend.MIN_TRADE_VOLUME || national.avg <= 0) continue;

    const byRegion = new Map<Region, MoaRow[]>();
    for (const row of dayRows) {
      const region = regionOf(row.MarketName);
      const bucket = byRegion.get(region);
      if (bucket) bucket.push(row);
      else byRegion.set(region, [row]);
    }

    const regions: RegionDay[] = [];
    for (const [region, regionRows] of byRegion) {
      const blended = backend.weightedAverage(regionRows);
      if (!(blended.avg > 0)) continue;
      regions.push({
        region,
        catty: blended.avg * backend.CATTY_PER_KG,
        volume: blended.volume,
        markets: [...new Set(regionRows.map((r) => normalizeMarket(r.MarketName)))].sort(),
        qualified: blended.volume >= backend.MIN_TRADE_VOLUME,
      });
    }

    out.push({
      date,
      nationalCatty: national.avg * backend.CATTY_PER_KG,
      nationalVolume: national.volume,
      nationalMarkets: national.markets,
      regions: regions.sort((a, b) => a.region.localeCompare(b.region)),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Per-crop and per-region statistics over a crop's daily split. */
export function cropStats(def: CropDef, days: CropDay[]): CropStats {
  const spreads: number[] = [];
  let spreadDays = 0;
  for (const day of days) {
    const qualified = day.regions.filter((r) => r.qualified && r.region !== '其他');
    if (qualified.length < 2) continue;
    const prices = qualified.map((r) => r.catty);
    spreadDays += 1;
    spreads.push(((Math.max(...prices) - Math.min(...prices)) / day.nationalCatty) * 100);
  }

  const regions = REGIONS.map((region) => regionStats(region, days));
  return {
    name: def.name,
    official: def.official,
    category: def.category,
    days: days.length,
    volume: days.reduce((sum, d) => sum + d.nationalVolume, 0),
    spreadDays,
    medianSpreadPct: quantile(spreads, 0.5),
    p90SpreadPct: quantile(spreads, 0.9),
    regions,
    viableRegions: regions.filter((r) => r.viable).length,
  };
}

function regionStats(region: Region, days: CropDay[]): RegionStats {
  const deviations: number[] = [];
  const markets: number[] = [];
  const volumes: number[] = [];
  /** Only qualifying days, in date order — the series a regional tab would show. */
  const series: { day: CropDay; entry: RegionDay }[] = [];

  for (const day of days) {
    const entry = day.regions.find((r) => r.region === region);
    if (!entry || !entry.qualified) continue;
    series.push({ day, entry });
    markets.push(entry.markets.length);
    volumes.push(entry.volume);
    deviations.push(((entry.catty - day.nationalCatty) / day.nationalCatty) * 100);
  }

  const changeGaps: number[] = [];
  const gapDays: number[] = [];
  let churned = 0;
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1];
    const now = series[i];
    // The nationwide move is taken over the SAME date pair, so the two changes
    // differ only by the regional split and not by which days were compared.
    const regionalChange = ((now.entry.catty - prev.entry.catty) / prev.entry.catty) * 100;
    const nationalChange = ((now.day.nationalCatty - prev.day.nationalCatty) / prev.day.nationalCatty) * 100;
    changeGaps.push(Math.abs(regionalChange - nationalChange));
    gapDays.push(Math.round((Date.parse(`${now.day.date}T00:00:00Z`) - Date.parse(`${prev.day.date}T00:00:00Z`)) / 86_400_000));
    if (prev.entry.markets.join('|') !== now.entry.markets.join('|')) churned += 1;
  }

  const coverage = days.length ? series.length / days.length : 0;
  return {
    region,
    qualifiedDays: series.length,
    coverage,
    medianMarkets: quantile(markets, 0.5),
    medianVolume: quantile(volumes, 0.5),
    medianDeviationPct: quantile(deviations, 0.5),
    p90AbsDeviationPct: quantile(deviations.map(Math.abs), 0.9),
    changePairs: changeGaps.length,
    medianGapDays: quantile(gapDays, 0.5),
    medianChangeGapPct: quantile(changeGaps, 0.5),
    p90ChangeGapPct: quantile(changeGaps, 0.9),
    mixChurn: changeGaps.length ? churned / changeGaps.length : 0,
    viable: coverage >= VIABLE_COVERAGE,
  };
}

/**
 * Every market the run saw, with the region the table assigned it.
 *
 * This is the deliverable issue #23 asks for first — its market table is marked
 * "to be verified against the actual MarketCode" and nothing in the repository
 * has ever held MOA's roster. Sightings are counted over `tradedRows` so that
 * `休市` placeholders cannot invent a market that did not trade.
 *
 * The population is the one the rest of the report measures: each item's own
 * `selectRows` output, not every row MOA returned. The unmapped-volume share
 * here is what decides whether the whole report can be trusted, so it has to
 * be a share OF the rows sections 2–5 are built from — counting crops no board
 * item accepts would have it quantify distortion in a different population
 * than the one it gates.
 *
 * `selectRows` also settles MOA's SUBSTRING matching on its own: a request for
 * 蘿蔔 answers with 胡蘿蔔's rows too (as 甘薯/甘薯葉 and 番茄/小番茄 do), and an
 * exact root match drops them. Rows are still de-duplicated, because two board
 * items can share a root, and a transaction counted twice would inflate that
 * market's volume and the gate with it.
 */
export function marketSightings(defs: CropDef[], rowsByRoot: Map<string, MoaRow[]>): MarketSighting[] {
  const backend = loadBackend();
  const seen = new Map<string, { codes: Set<string>; dates: Set<string>; volume: number }>();
  const counted = new Set<string>();
  for (const def of defs) {
    for (const row of backend.selectRows(rowsByRoot.get(def.official) ?? [], def)) {
      const name = normalizeMarket(row.MarketName);
      if (!name) continue;
      // The overlapping responses carry the SAME row, field for field, so the
      // price and quantity go into the identity too: a row that differs in any
      // of them is a different transaction and is kept, whatever MOA's
      // per-market-per-day shape turns out to be.
      const identity = [row.TransDate, row.MarketCode, name, row.CropName,
                        row.Avg_Price, row.Trans_Quantity].join('\u0000');
      if (counted.has(identity)) continue;
      counted.add(identity);
      let entry = seen.get(name);
      if (!entry) {
        entry = { codes: new Set(), dates: new Set(), volume: 0 };
        seen.set(name, entry);
      }
      if (row.MarketCode) entry.codes.add(String(row.MarketCode));
      entry.dates.add(String(row.TransDate ?? ''));
      // `parseFloat`, like `weightedAverage` and `tradedRows`: the gate a row
      // already passed is a parseFloat one, so `Number` here could turn a
      // quantity the board accepted into NaN — and one NaN in a plain sum
      // renders every 占全國 cell, and the unmapped-volume gate, as NaN%.
      entry.volume += parseFloat(String(row.Trans_Quantity ?? 0)) || 0;
    }
  }
  return [...seen.entries()]
    .map(([name, entry]) => ({
      name,
      codes: [...entry.codes].sort(),
      region: regionOf(name),
      days: entry.dates.size,
      volume: entry.volume,
    }))
    .sort((a, b) => b.volume - a.volume);
}

/**
 * Linear-interpolated quantile of an unsorted sample; 0 for an empty one.
 *
 * At q = 0.5 this is exactly the backend's `median` (a test asserts it), but the
 * report needs a p90 as well: a feature is judged by its bad days, and a median
 * spread of 4% with a p90 of 35% is a different product decision from a flat 4%.
 */
export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
