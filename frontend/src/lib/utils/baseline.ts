import type { ProduceItem } from '../../types/produce';

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
  if (item.suspect === true) return null;
  const vs = item.vs_baseline_percent;
  return typeof vs === 'number' && Number.isFinite(vs) ? vs : null;
}
