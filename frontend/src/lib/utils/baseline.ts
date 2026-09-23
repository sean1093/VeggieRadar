import type { ProduceItem, ProduceVariety } from '../../types/produce';

/**
 * Today's distance from the item's own monthly baseline, or null when that
 * comparison cannot be trusted.
 *
 * One rule, four readers: the 划算優先 ordering, the card's 比近月便宜 badge,
 * the drawer's baseline line, and whether the sort option is offered at all.
 * They disagreed. `suspect` means the backend's plausibility guard (README §2)
 * judged today's trade untrustworthy — volume collapsing while the price
 * spikes, usually one outlier trade dragging the average — so the card and the
 * drawer withhold everything derived from comparing today with another day,
 * while the comparator read the same number anyway. A flagged item could take
 * first place in 划算優先 on a figure its own card refuses to show, above
 * items with real discounts (#70).
 *
 * A value rather than a predicate, because every caller needs the number as
 * well as the verdict, and `hasTrustedBaseline(item) && vs != null` at each of
 * them is the same duplication one step further along.
 */
export function trustedBaseline(item: ProduceItem): number | null {
  return trustedPercent(item, item.vs_baseline_percent);
}

/**
 * The one trust rule for a comparison of today with another day: a finite
 * number, on an item the guard did not flag.
 */
function trustedPercent(item: ProduceItem, vs: number | undefined): number | null {
  if (item.suspect === true) return null;
  return typeof vs === 'number' && Number.isFinite(vs) ? vs : null;
}

/**
 * A variety row's distance from that variety's own monthly median (#22 §3),
 * or null. The item's rule: nothing that compares today with another day is
 * trusted on a day the guard flagged.
 */
export function trustedVarietyBaseline(item: ProduceItem, variety: ProduceVariety): number | null {
  return trustedPercent(item, variety.vs_baseline_percent);
}

/**
 * 「低 N%」「高 N%」 or 「持平」 for a percentage difference, as the drawer's
 * comparison sentences say it. Rounded FIRST: −0.4 is 持平, not 「低 0%」.
 */
export function relativePhrase(percent: number): string {
  const rounded = Math.round(Math.abs(percent));
  if (rounded === 0) return '持平';
  return percent < 0 ? `低 ${rounded}%` : `高 ${rounded}%`;
}

/**
 * Today against the same weeks last year (#22 §2), or null when that
 * comparison cannot be trusted or is not there. The same rule as
 * `trustedBaseline`: a day the guard flagged is compared with nothing.
 *
 * Both numbers or neither — the sentence needs the price and the difference,
 * and a half-sent pair is a backend defect, not something to render around.
 */
export function trustedLastYear(item: ProduceItem): { price: number; percent: number } | null {
  if (item.suspect === true) return null;
  const price = item.last_year_price;
  const percent = item.vs_last_year_percent;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  return { price, percent };
}
