import type { ProduceItem } from '../../types/produce';
import { trustedBaseline } from './baseline';

/**
 * Comparator for 划算優先: the further below its own monthly baseline, the
 * earlier the item. An item whose baseline comparison cannot be trusted —
 * missing or non-finite (old cached boards, corrupt payloads), or flagged
 * `suspect` by the backend's plausibility guard — sinks to the bottom and
 * keeps its curated relative order under a stable sort. The ranking must never
 * pretend to order data it does not have, a NaN comparator result would leave
 * such items floating wherever the sort left them, and ranking on a number the
 * card itself refuses to show leaves the visitor no way to read the result.
 */
export function byValueFirst(a: ProduceItem, b: ProduceItem): number {
  const av = trustedBaseline(a) ?? Number.MAX_SAFE_INTEGER;
  const bv = trustedBaseline(b) ?? Number.MAX_SAFE_INTEGER;
  return av - bv;
}
