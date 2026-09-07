/**
 * The tier-3 fallback: one hand-tuned `[low, mid, high]` markup band per
 * front-end category, in 元/台斤.
 *
 * This table is an INPUT, not an output. Nothing fits it — it is the coarse
 * default a crop lands on when it has too few observations, and it is also the
 * yardstick tier 2 has to beat (`isNarrowerThanCategory`), so the tool must own
 * the numbers it measures against. `emit.ts` copies them into the generated
 * file verbatim; changing a band is a deliberate edit here, reviewed like code.
 *
 * The values are the ones that shipped with the first calibration; they were
 * tuned by hand against the same two retail feeds and have never been refitted.
 */
export type MarkupBand = [low: number, mid: number, high: number];

export const RETAIL_MARKUP_CATEGORY: Record<string, MarkupBand> = {
  '葉菜類': [20, 35, 50],
  '根莖類': [19, 28, 48],
  '果菜類': [48, 70, 88],
  '瓜果類': [22, 32, 50],
  '辛香類': [45, 55, 80],
  '菇類': [40, 60, 85],
  '水果': [17, 32, 62],
  '其他': [20, 35, 50],
};

/** The band a crop falls back to, mirroring `retailBand`'s own default. */
export function categoryBand(category: string): MarkupBand {
  return RETAIL_MARKUP_CATEGORY[category] ?? RETAIL_MARKUP_CATEGORY['其他'];
}
