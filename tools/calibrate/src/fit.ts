/**
 * The rules, as code.
 *
 * README §4 explains what is listed and why in prose. Each of those "why"s is
 * one exported predicate here, with a test for the normal case, the boundary
 * and the case that must be refused — because the constraints were all learned
 * from measurements that contradicted the obvious guess, and prose cannot stop
 * the next refit from quietly dropping one.
 *
 * Everything is 元/台斤 and everything is ADDITIVE: the markup is
 * `retail − wholesale`, never a ratio. §4 has the evidence for that choice.
 */
import { loadBackend } from './backend.ts';
import { categoryBand } from './category-bands.ts';
import type { MarkupBand } from './category-bands.ts';
import type { Observation, SourceName } from './join.ts';

/** Rule 1's threshold: below this a crop's own markup is noise. 龍眼/枇杷 sit at 5. */
export const MIN_OBSERVATIONS = 8;

/** Rule 5's split: the newest fifth of a crop's observations is never fitted on. */
export const HOLDOUT_FRACTION = 0.2;

export type Tier = 'tier1' | 'tier2' | 'category';

export type CropFit = {
  root: string;
  category: string;
  tier: Tier;
  /** True when the crop gets its own entry in a generated table. */
  listed: boolean;
  /** Why this tier, in the report's words. */
  reason: string;
  counts: Record<SourceName, number> & { total: number };
  /** Tier-1 only: the fitted midpoint markup. */
  markup?: number;
  /** Tier-2 only: the fitted [p10, median, p90] band. */
  band?: MarkupBand;
  categoryBand: MarkupBand;
  /** Fitted band before rule 2 rejected it, for the report. */
  rejectedBand?: MarkupBand;
};

/**
 * RULE 1 — a crop needs at least `MIN_OBSERVATIONS` paired days to be listed.
 *
 * 龍眼 and 枇杷 have five each: their seasons are too short. A quantile band
 * fitted on five points describes those five days, not the crop.
 */
export function hasEnoughObservations(count: number): boolean {
  return count >= MIN_OBSERVATIONS;
}

/**
 * RULE 2 — a tier-2 band must be STRICTLY narrower than the category band it
 * replaces, or the crop falls back to that category.
 *
 * `<`, not `<=`: an equally wide band tells the shopper nothing the default
 * did not already say. That is what excludes 豌豆 and 洋香瓜, whose fitted
 * spread came out exactly as wide as their category's.
 */
export function isNarrowerThanCategory(band: MarkupBand, fallback: MarkupBand): boolean {
  return band[2] - band[0] < fallback[2] - fallback[0];
}

/**
 * RULE 2b — the band must also be a usable band: positive and strictly
 * increasing. A crop whose p10 and median round to the same NT$ has no spread
 * to publish, and `retailBand` would hand the UI a degenerate range.
 */
export function isOrderedBand(band: MarkupBand): boolean {
  return band[0] > 0 && band[0] < band[1] && band[1] < band[2];
}

/**
 * RULE 3 — which pipeline a crop belongs to.
 *
 * Daily Taichung coverage means enough observations for a tier-1 midpoint, so
 * such a crop is a tier-1 candidate and is NOT eligible for tier 2. Mixing the
 * two sources once produced a flattering blended figure that hid a coverage
 * collapse on the Taichung side; 雜柑, 甜橙 and 海梨柑 are the crops this
 * separates out. Tier 2 is therefore Taipei-only by construction.
 */
export function tierFor(counts: Record<SourceName, number>): Tier {
  if (hasEnoughObservations(counts.taichung)) return 'tier1';
  if (hasEnoughObservations(counts.taipei)) return 'tier2';
  return 'category';
}

/**
 * RULE 4a — the tier-1 number is the MEDIAN of the crop's additive markups,
 * rounded to whole NT$.
 *
 * The median, not the mean: a single mis-surveyed stall price would drag a mean
 * by NT$10. Whole NT$ only — the outward NT$5 rounding belongs to `retailBand`
 * at serving time, and rounding here as well would compound to NT$10 steps.
 */
export function tier1Midpoint(markups: number[]): number {
  return Math.round(loadBackend().median(markups));
}

/**
 * RULE 4b — the tier-2 number is the crop's OWN `[p10, median, p90]`, rounded
 * to whole NT$.
 *
 * Quantiles rather than a multiple of the midpoint: reusing tier 1's
 * `× 0.75 … × 1.35` band here lost coverage against the very fallback it was
 * meant to beat. The spread is not proportional to the markup.
 */
export function tier2Band(markups: number[]): MarkupBand {
  const sorted = [...markups].sort((a, b) => a - b);
  return [
    Math.round(quantile(sorted, 0.1)),
    Math.round(loadBackend().median(sorted)),
    Math.round(quantile(sorted, 0.9)),
  ];
}

/**
 * Linearly interpolated quantile of an ascending array (the "type 7"
 * definition, which is what R, numpy and Excel default to). Named because the
 * choice matters at these sample sizes: with 18 monthly observations, p10 is
 * interpolated between the 2nd and 3rd value rather than snapped to one.
 */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) throw new Error('quantile of an empty sample');
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

/**
 * RULE 5 — the holdout is strictly AFTER the fit window in time.
 *
 * Fit on the oldest 80 % of a crop's observations, evaluate on the newest 20 %.
 * The boundary never splits a date: every observation sharing the first
 * held-out date's day would otherwise let the fit see the future. This is the
 * contamination README §4 admits to for the original tier-1 constants, which
 * is the whole reason the split lives in code now.
 */
export function splitByTime(observations: Observation[]): { fit: Observation[]; holdout: Observation[] } {
  const sorted = [...observations].sort((a, b) => a.date.localeCompare(b.date));
  let cut = Math.floor(sorted.length * (1 - HOLDOUT_FRACTION));
  // Push the cut past every observation that shares the boundary date.
  while (cut > 0 && cut < sorted.length && sorted[cut - 1].date === sorted[cut].date) cut += 1;
  if (cut >= sorted.length) return { fit: sorted, holdout: [] };
  return { fit: sorted.slice(0, cut), holdout: sorted.slice(cut) };
}

/**
 * Applies rules 1-4 to every crop with observations, in the order README §4
 * states them. Rule 5 is the evaluator's job, not the emitter's: the shipped
 * numbers are fitted on ALL of a crop's observations, and the holdout exists to
 * measure the rule, not to shrink the training set of what ships.
 */
export function fitCrops(observations: Observation[]): CropFit[] {
  const backend = loadBackend();
  const byRoot: Record<string, Observation[]> = {};
  for (const observation of observations) (byRoot[observation.root] ??= []).push(observation);

  const fits: CropFit[] = [];
  for (const root of Object.keys(byRoot).sort()) {
    const own = byRoot[root];
    const counts = {
      taichung: own.filter((o) => o.source === 'taichung').length,
      taipei: own.filter((o) => o.source === 'taipei').length,
      total: own.length,
    };
    const category = backend.categoryOf(root);
    const fallback = categoryBand(category);
    const tier = tierFor(counts);

    if (tier === 'tier1') {
      // Tier 1 is fitted on the daily source only, so its midpoint means the
      // same thing for every crop in the table.
      const markups = own.filter((o) => o.source === 'taichung').map((o) => o.markup);
      fits.push({
        root, category, tier, listed: true, counts, categoryBand: fallback,
        markup: tier1Midpoint(markups),
        reason: `${counts.taichung} daily Taichung observations`,
      });
      continue;
    }

    if (tier === 'category') {
      fits.push({
        root, category, tier, listed: false, counts, categoryBand: fallback,
        reason: `only ${counts.total} paired observations, below the ${MIN_OBSERVATIONS} needed`,
      });
      continue;
    }

    const markups = own.filter((o) => o.source === 'taipei').map((o) => o.markup);
    const band = tier2Band(markups);
    if (!isOrderedBand(band)) {
      fits.push({
        root, category, tier: 'category', listed: false, counts, categoryBand: fallback, rejectedBand: band,
        reason: `fitted band [${band.join(', ')}] is not a usable range`,
      });
      continue;
    }
    if (!isNarrowerThanCategory(band, fallback)) {
      fits.push({
        root, category, tier: 'category', listed: false, counts, categoryBand: fallback, rejectedBand: band,
        reason: `spread ${band[2] - band[0]} is not narrower than ${category}'s ${fallback[2] - fallback[0]}`,
      });
      continue;
    }
    fits.push({
      root, category, tier, listed: true, counts, categoryBand: fallback, band,
      reason: `${counts.taipei} monthly Taipei observations`,
    });
  }
  return fits;
}
