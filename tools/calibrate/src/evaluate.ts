/**
 * Held-out accuracy: the three rows of README §4's table.
 *
 * The comparison is between three ways of turning a wholesale price into a
 * retail band, measured on observations no rule was fitted on:
 *
 *   1. the category fallback — what the app did before tier 2 existed;
 *   2. tier 1's shape applied per crop — a midpoint with a `× 0.75 … × 1.35`
 *      band, which is the obvious extension and the one that failed;
 *   3. the crop's own `[p10, median, p90]` — what tier 2 ships.
 *
 * Coverage is the share of held-out days whose real retail price fell inside
 * the band. The error is the median absolute percentage error of the band's
 * MIDPOINT against the real retail price, which is the number the card's big
 * digits carry.
 *
 * Bands are compared unrounded. `retailBand`'s outward NT$5 rounding only ever
 * widens a band, so rounding here would flatter all three rules by the same
 * accident and hide which one is actually better.
 */
import { loadBackend } from './backend.ts';
import { categoryBand } from './category-bands.ts';
import type { MarkupBand } from './category-bands.ts';
import { splitByTime, tier1Midpoint, tier2Band, tierFor } from './fit.ts';
import type { Observation } from './join.ts';

export type RuleName = 'category' | 'tier1-style' | 'per-crop-quantile';

export type RuleScore = {
  rule: RuleName;
  covered: number;
  evaluated: number;
  /** Share of held-out observations inside the band, 0..1. */
  coverage: number;
  /** Median |predicted − actual| / actual of the midpoint, 0..1. */
  medianAbsError: number;
};

export type Holdout = {
  /** Crops with a holdout: the tier-2 candidate set, which is what §4 measures. */
  crops: string[];
  observations: number;
  scores: RuleScore[];
};

/**
 * Scores the three rules on the crops tier 2 is *about*: the roots `tierFor`
 * assigns to tier 2 — Taipei-sourced, enough observations to be listed, and
 * WITHOUT the daily Taichung coverage that makes a crop a tier-1 crop instead.
 *
 * Excluding tier-1 roots is the whole point of the population. They carry
 * hundreds of daily observations each against tier 2's ~18 monthly ones, so
 * leaving them in lets a handful of daily crops dominate every average and the
 * table then answers "how do the rules do on 甘藍" rather than "which rule
 * should serve the crops that have no daily feed" — the decision this table
 * exists to make.
 */
export function evaluateHoldout(observations: Observation[]): Holdout {
  const backend = loadBackend();
  const byRoot: Record<string, Observation[]> = {};
  for (const observation of observations) (byRoot[observation.root] ??= []).push(observation);

  const errors: Record<RuleName, number[]> = { 'category': [], 'tier1-style': [], 'per-crop-quantile': [] };
  const covered: Record<RuleName, number> = { 'category': 0, 'tier1-style': 0, 'per-crop-quantile': 0 };
  const crops: string[] = [];
  let evaluated = 0;

  for (const root of Object.keys(byRoot).sort()) {
    const all = byRoot[root];
    const tier = tierFor({
      taichung: all.filter((o) => o.source === 'taichung').length,
      taipei: all.filter((o) => o.source === 'taipei').length,
    });
    if (tier !== 'tier2') continue;
    // Tier 2 is fitted on the monthly source alone (rule 3), so it is measured
    // on it too: scoring against Taichung days the table will never serve
    // would report an accuracy the shipped rule does not have.
    const own = all.filter((o) => o.source === 'taipei');
    const { fit, holdout } = splitByTime(own);
    if (!holdout.length || !fit.length) continue;

    const markups = fit.map((o) => o.markup);
    const fallback = categoryBand(backend.categoryOf(root));
    const midpoint = tier1Midpoint(markups);
    const bands: Record<RuleName, MarkupBand> = {
      'category': fallback,
      'tier1-style': [midpoint * backend.RETAIL_BAND_LOW, midpoint, midpoint * backend.RETAIL_BAND_HIGH],
      'per-crop-quantile': tier2Band(markups),
    };

    crops.push(root);
    evaluated += holdout.length;
    for (const observation of holdout) {
      for (const rule of Object.keys(bands) as RuleName[]) {
        const [low, mid, high] = bands[rule];
        if (observation.retail >= observation.wholesale + low && observation.retail <= observation.wholesale + high) {
          covered[rule] += 1;
        }
        errors[rule].push(Math.abs(observation.wholesale + mid - observation.retail) / observation.retail);
      }
    }
  }

  const scores = (Object.keys(errors) as RuleName[]).map((rule) => ({
    rule,
    covered: covered[rule],
    evaluated,
    coverage: evaluated ? covered[rule] / evaluated : 0,
    medianAbsError: errors[rule].length ? backend.median(errors[rule]) : 0,
  }));
  return { crops, observations: evaluated, scores };
}
