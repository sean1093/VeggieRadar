/**
 * Wholesale market → region, and the vocabulary the measurement reports in.
 *
 * **This table is a hypothesis, not a fact.** Issue #23 sketches the four
 * regions and marks the market list "to be verified against the actual
 * MarketCode"; the repository has never held MOA's market roster (the crop
 * crawler discovers it at runtime, `tools/catalog/src/build-catalog.ts`), so
 * the spellings below are seeded from the issue and from the two names the
 * committed fixture proves — `台北一`, `台北二` — and nothing else.
 *
 * That is why `regionOf` never guesses. A market whose name is not in the
 * table lands in `其他`, the run reports every distinct market it saw with the
 * region it was assigned, and the report fails its own mapping check while any
 * unmapped market carries real volume. Verifying the table is the first thing
 * a run produces, before any conclusion is drawn from it.
 *
 * Matching is on `MarketName` rather than `MarketCode` because the code is the
 * part nobody has checked: `台北二` is `104` in the fixture and that is the
 * whole of the evidence. Names are what the feed shows and what a human can
 * confirm against the report.
 */

/** The four regions of issue #23, plus the bucket for anything unmapped. */
export const REGIONS = ['北', '中', '南', '東'] as const;
export type Region = (typeof REGIONS)[number] | '其他';

/**
 * Seeded from issue #23's table. MOA spells some markets with a 市/鎮/鄉
 * suffix and some without, so several plausible spellings map to the same
 * region — a spelling that never appears simply never matches, which costs
 * nothing, while a missing one shows up in the report as unmapped volume.
 */
export const REGION_BY_MARKET: Record<string, Region> = {
  // 北
  台北一: '北', 臺北一: '北',
  台北二: '北', 臺北二: '北',
  三重: '北', 三重市: '北',
  桃園: '北', 桃園市: '北',
  板橋: '北', 板橋區: '北',
  台北市: '北', 臺北市: '北',

  // 中
  台中市: '中', 臺中市: '中', 台中: '中', 臺中: '中',
  豐原: '中', 豐原區: '中',
  東勢: '中', 東勢鎮: '中',
  彰化: '中', 彰化市: '中',
  南投: '中', 南投市: '中',
  溪湖: '中', 溪湖鎮: '中',
  永靖: '中', 永靖鄉: '中',
  西螺: '中', 西螺鎮: '中',

  // 南
  高雄: '南', 高雄市: '南',
  鳳山: '南', 鳳山區: '南',
  屏東: '南', 屏東市: '南',
  台南: '南', 臺南: '南', 台南市: '南', 臺南市: '南',
  嘉義: '南', 嘉義市: '南',

  // 東
  宜蘭: '東', 宜蘭市: '東',
  花蓮: '東', 花蓮市: '東',
  台東: '東', 臺東: '東', 台東市: '東', 臺東市: '東',
};

/**
 * The region a market trades in, or `其他` when the table has never been
 * confirmed to contain it.
 *
 * MOA pads some `MarketName` values, and a few carry the market code as a
 * prefix (`104 台北二`), so the raw value is trimmed and a leading numeric
 * code is dropped before lookup. Nothing else is inferred: no prefix search,
 * no fuzzy match. A near-miss that silently landed in the wrong region would
 * be indistinguishable from a real regional price difference, which is the one
 * error this whole measurement exists to rule out.
 */
export function regionOf(marketName: string | undefined): Region {
  return REGION_BY_MARKET[normalizeMarket(marketName)] ?? '其他';
}

/** `' 104 台北二 '` → `'台北二'`; anything else is returned trimmed. */
export function normalizeMarket(marketName: string | undefined): string {
  return String(marketName ?? '').trim().replace(/^\d+\s*/, '');
}
