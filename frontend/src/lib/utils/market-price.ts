import type { ProduceItem } from '../../types/produce';

/**
 * Estimated traditional-market price in 元/台斤 — what a shopper actually hands
 * over at the stall, and therefore the number the UI leads with.
 *
 * `retail_price` is the backend's calibrated midpoint. Older cached boards may
 * ship only the band edges, so the midpoint is derived from them; boards from
 * before the retail estimate existed ship neither and return null, letting the
 * caller fall back to the measured wholesale price.
 */
export function marketPrice(item: ProduceItem): number | null {
  if (item.retail_low == null || item.retail_high == null) return null;
  return item.retail_price ?? Math.round((item.retail_low + item.retail_high) / 2);
}
