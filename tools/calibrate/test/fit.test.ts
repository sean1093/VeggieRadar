/**
 * The five listing rules, each with a normal case, its boundary, and the case
 * it must refuse. README §4 says every one of these contradicted the obvious
 * guess, so each needs a test that fails when a refit quietly relaxes it.
 */
import { describe, it, expect } from 'vitest';
import {
  MIN_OBSERVATIONS, HOLDOUT_FRACTION,
  hasEnoughObservations, isNarrowerThanCategory, isOrderedBand, tierFor,
  tier1Midpoint, tier2Band, quantile, splitByTime, fitCrops,
} from '../src/fit.ts';
import type { Observation, SourceName } from '../src/join.ts';

const observation = (source: SourceName, root: string, date: string, markup: number, wholesale = 20): Observation =>
  ({ source, root, date, wholesale, retail: wholesale + markup, markup });

/** `count` monthly observations for one crop, one per month, markups in order. */
function monthly(root: string, markups: number[]): Observation[] {
  return markups.map((markup, i) => observation('taipei', root, `2025-${String(i + 1).padStart(2, '0')}-01`, markup));
}

describe('rule 1 — a crop needs enough paired observations', () => {
  it('lists a crop with more than the minimum', () => {
    expect(hasEnoughObservations(MIN_OBSERVATIONS + 4)).toBe(true);
  });

  it('accepts exactly the minimum', () => {
    expect(MIN_OBSERVATIONS).toBe(8);
    expect(hasEnoughObservations(8)).toBe(true);
  });

  it('refuses one short — the 龍眼/枇杷 case is 5', () => {
    expect(hasEnoughObservations(7)).toBe(false);
    expect(hasEnoughObservations(5)).toBe(false);
  });
});

describe('rule 2 — a tier-2 band must be strictly narrower than its category', () => {
  it('accepts a genuinely tighter band', () => {
    expect(isNarrowerThanCategory([53, 59, 68], [48, 70, 88])).toBe(true);
  });

  it('refuses an equally wide band — 豌豆 and 洋香瓜 came out exactly this wide', () => {
    expect(isNarrowerThanCategory([50, 60, 90], [48, 70, 88])).toBe(false);
  });

  it('refuses a wider band — the 竹筍 case, where one root spans two varieties', () => {
    expect(isNarrowerThanCategory([40, 90, 200], [19, 28, 48])).toBe(false);
  });

  it('needs a positive, strictly increasing band to publish at all', () => {
    expect(isOrderedBand([20, 32, 36])).toBe(true);
    expect(isOrderedBand([32, 32, 36])).toBe(false); // p10 and median round together
    expect(isOrderedBand([0, 32, 36])).toBe(false);
    expect(isOrderedBand([-4, 32, 36])).toBe(false);
  });
});

describe('rule 3 — daily coverage means tier 1, so tier 2 is Taipei-only', () => {
  it('sends a crop with daily Taichung coverage to tier 1 even when Taipei has more', () => {
    expect(tierFor({ taichung: 200, taipei: 18 })).toBe('tier1');
  });

  it('switches at exactly the minimum — 8 Taichung days is already tier 1', () => {
    expect(tierFor({ taichung: 8, taipei: 18 })).toBe('tier1');
    expect(tierFor({ taichung: 7, taipei: 18 })).toBe('tier2');
  });

  it('falls back to the category when neither source reaches the minimum', () => {
    expect(tierFor({ taichung: 7, taipei: 5 })).toBe('category');
  });
});

describe('rule 4 — what the emitted numbers are', () => {
  it('takes the median markup as the tier-1 midpoint, in whole NT$', () => {
    expect(tier1Midpoint([20, 28, 29, 30, 90])).toBe(29);
    // Even count averages the middle pair, then rounds once.
    expect(tier1Midpoint([28, 29])).toBe(29);
    expect(tier1Midpoint([28.4, 28.4])).toBe(28);
  });

  it('takes [p10, median, p90] of the crop\'s own distribution for tier 2', () => {
    const markups = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(tier2Band(markups)).toEqual([19, 55, 91]);
  });

  it('interpolates quantiles rather than snapping to a sample point', () => {
    expect(quantile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(quantile([10, 20, 30, 40, 50], 0.1)).toBe(14);
    expect(quantile([10, 20, 30, 40, 50], 0)).toBe(10);
    expect(quantile([10, 20, 30, 40, 50], 1)).toBe(50);
    expect(quantile([42], 0.9)).toBe(42);
  });

  it('rounds once, leaving the outward NT$5 step to retailBand', () => {
    // 32.4 must not become 35 here: retailBand rounds the SUM outward, and
    // rounding twice would compound into NT$10 steps on the card.
    expect(tier2Band([32.4, 32.4, 32.4, 32.4, 32.4, 32.4, 32.4, 32.4])).toEqual([32, 32, 32]);
  });

  it('refuses a quantile of nothing instead of inventing one', () => {
    expect(() => quantile([], 0.5)).toThrow(/empty sample/);
  });
});

describe('rule 5 — the holdout is strictly after the fit window', () => {
  it('fits on the oldest 80% and holds out the newest 20%', () => {
    expect(HOLDOUT_FRACTION).toBe(0.2);
    const observations = monthly('甲', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { fit, holdout } = splitByTime(observations);
    expect(fit).toHaveLength(8);
    expect(holdout).toHaveLength(2);
    expect(holdout.every((h) => fit.every((f) => f.date < h.date))).toBe(true);
  });

  it('never splits a date across the boundary — a tied day joins the fit', () => {
    // Ten observations, but the 8th and 9th share a date: keeping the cut at 8
    // would let the fit see a day it is then scored on.
    const observations = [
      ...monthly('甲', [1, 2, 3, 4, 5, 6, 7, 8]),
      observation('taipei', '甲', '2025-08-01', 9),
      observation('taipei', '甲', '2025-09-01', 10),
    ];
    const { fit, holdout } = splitByTime(observations);
    expect(fit).toHaveLength(9);
    expect(holdout).toHaveLength(1);
    expect(new Set(fit.map((f) => f.date)).size).toBe(8);
    expect(holdout[0].date).toBe('2025-09-01');
  });

  it('reports no holdout when every observation shares one date', () => {
    const observations = [1, 2, 3, 4, 5, 6, 7, 8].map((m) => observation('taipei', '甲', '2025-03-01', m));
    const { fit, holdout } = splitByTime(observations);
    expect(fit).toHaveLength(8);
    expect(holdout).toHaveLength(0);
  });

  it('sorts by date before splitting, so feed order cannot leak the future', () => {
    const shuffled = [
      observation('taipei', '甲', '2025-05-01', 5),
      observation('taipei', '甲', '2025-01-01', 1),
      observation('taipei', '甲', '2025-04-01', 4),
      observation('taipei', '甲', '2025-02-01', 2),
      observation('taipei', '甲', '2025-03-01', 3),
    ];
    const { fit, holdout } = splitByTime(shuffled);
    expect(fit.map((f) => f.markup)).toEqual([1, 2, 3, 4]);
    expect(holdout.map((h) => h.markup)).toEqual([5]);
  });
});

describe('fitCrops applies the rules in README §4\'s order', () => {
  it('lists a daily crop on tier 1 and a monthly crop on tier 2', () => {
    const daily = Array.from({ length: 30 }, (_, i) =>
      observation('taichung', '甘藍', `2026-01-${String(i + 1).padStart(2, '0')}`, 29));
    const monthlyOnly = monthly('番茄', [53, 55, 56, 57, 59, 60, 62, 64, 66, 68]);
    const fits = fitCrops([...daily, ...monthlyOnly]);

    const cabbage = fits.find((f) => f.root === '甘藍');
    expect(cabbage?.tier).toBe('tier1');
    expect(cabbage?.markup).toBe(29);
    expect(cabbage?.band).toBeUndefined();

    const tomato = fits.find((f) => f.root === '番茄');
    expect(tomato?.tier).toBe('tier2');
    // p10 interpolates 53→55 at 0.9 of the first gap (54.8), median is 59.5.
    expect(tomato?.band).toEqual([55, 60, 66]);
  });

  it('drops a crop whose band is not tighter than its category, with the reason', () => {
    // 竹筍 is 根莖類: category spread 48 − 19 = 29. Two varieties trading far
    // apart give a spread far wider than that.
    const fits = fitCrops(monthly('竹筍', [30, 40, 50, 90, 120, 150, 180, 200, 220, 240]));
    const shoot = fits.find((f) => f.root === '竹筍');
    expect(shoot?.listed).toBe(false);
    expect(shoot?.tier).toBe('category');
    expect(shoot?.reason).toMatch(/not narrower than 根莖類/);
    expect(shoot?.rejectedBand).toBeDefined();
  });

  it('drops a short-season crop for want of observations', () => {
    const fits = fitCrops(monthly('龍眼', [40, 42, 45, 48, 50]));
    const longan = fits.find((f) => f.root === '龍眼');
    expect(longan?.listed).toBe(false);
    expect(longan?.reason).toMatch(/below the 8 needed/);
  });

  it('fits tier 1 on the daily source alone, ignoring the monthly rows', () => {
    // A mixed crop must not blend sources: the tier-1 midpoint has to mean the
    // same thing for every crop in the table.
    const daily = Array.from({ length: 10 }, (_, i) =>
      observation('taichung', '木瓜', `2026-02-${String(i + 1).padStart(2, '0')}`, 29));
    const noisy = monthly('木瓜', [200, 200, 200, 200, 200, 200, 200, 200]);
    const fits = fitCrops([...daily, ...noisy]);
    expect(fits.find((f) => f.root === '木瓜')?.markup).toBe(29);
  });
});
