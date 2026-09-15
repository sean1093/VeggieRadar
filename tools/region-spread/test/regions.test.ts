/**
 * The region table is a hypothesis about MOA's market roster, so what is tested
 * is the *discipline* around it, not the guesses inside it: a name the feed has
 * actually been observed to use resolves, anything else lands in 其他 loudly,
 * and no entry invents a fifth region.
 */
import { describe, it, expect } from 'vitest';
import { regionOf, normalizeMarket, REGION_BY_MARKET, REGIONS } from '../src/regions.ts';

describe('regionOf', () => {
  it('resolves the market names the committed MOA fixture proves', () => {
    // tools/calibrate/fixtures/moa-sample.json contains exactly these three.
    expect(regionOf('台北一')).toBe('北');
    expect(regionOf('台北二')).toBe('北');
    expect(regionOf('台中市')).toBe('中');
  });

  it('sends an unknown market to 其他 rather than guessing a region', () => {
    // A prefix or fuzzy match would put 新竹 in 北 on nothing but plausibility,
    // and a wrongly-placed market is indistinguishable from a real price gap.
    expect(regionOf('新竹市')).toBe('其他');
    expect(regionOf('台北三')).toBe('其他');
    expect(regionOf('')).toBe('其他');
    expect(regionOf(undefined)).toBe('其他');
  });

  it('strips a market-code prefix and surrounding space before lookup', () => {
    expect(normalizeMarket(' 104 台北二 ')).toBe('台北二');
    expect(normalizeMarket('台北二')).toBe('台北二');
    expect(regionOf(' 104 台北二 ')).toBe('北');
  });

  it('maps every table entry to one of the four regions of issue #23', () => {
    for (const [market, region] of Object.entries(REGION_BY_MARKET)) {
      expect(REGIONS, `${market} → ${region}`).toContain(region);
    }
  });
});
