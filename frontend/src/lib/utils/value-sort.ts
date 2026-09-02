import type { ProduceItem } from '../../types/produce';

/**
 * Comparator for 划算優先: the further below its own monthly baseline, the
 * earlier the item. Missing or non-finite values (old cached boards, corrupt
 * payloads) sink to the bottom and keep their curated relative order under a
 * stable sort — the ranking must never pretend to order data it does not
 * have, and a NaN comparator result would leave such items floating wherever
 * the sort left them.
 */
export function byValueFirst(a: ProduceItem, b: ProduceItem): number {
  const av = Number.isFinite(a.vs_baseline_percent)
    ? (a.vs_baseline_percent as number)
    : Number.MAX_SAFE_INTEGER;
  const bv = Number.isFinite(b.vs_baseline_percent)
    ? (b.vs_baseline_percent as number)
    : Number.MAX_SAFE_INTEGER;
  return av - bv;
}