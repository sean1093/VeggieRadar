import { describe, it, expect } from 'vitest';
import { MOCK_BOARD } from './mockBoard';

/**
 * The bundled board is what the app shows with no backend configured, and the
 * drawer now tells the reader in words that the headline is the volume-weighted
 * average of the variety rows. A hand-written fixture that contradicts its own
 * arithmetic would make the offline demo state something false — which is how
 * this fixture was actually caught drifting.
 */
describe('MOCK_BOARD internal consistency', () => {
  const withVarieties = MOCK_BOARD.items.filter((it) => it.varieties?.length);

  it('has at least one multi-variety item to demonstrate the feature', () => {
    expect(withVarieties.length).toBeGreaterThan(0);
  });

  it('keeps the headline the volume-weighted average of fully covered variety rows', () => {
    for (const item of withVarieties) {
      const rows = item.varieties ?? [];
      const shown = rows.reduce((sum, v) => sum + v.share_percent, 0);
      // Below 100% the drawer discloses a folded remainder, which legitimately
      // explains a gap between the rows and the blend.
      if (shown < 100) continue;

      const weighted = rows.reduce((sum, v) => sum + (v.retail_price ?? 0) * v.share_percent, 0) / shown;
      expect(item.retail_price).toBeDefined();
      expect(Math.abs((item.retail_price as number) - weighted)).toBeLessThanOrEqual(2);
    }
  });

  it('derives every variety estimate from its own wholesale price with one markup', () => {
    for (const item of withVarieties) {
      const rows = item.varieties ?? [];
      const markups = rows.map((v) => (v.retail_price ?? 0) - v.catty_price);
      // One additive markup per crop is the whole basis of the claim; a fixture
      // with per-variety markups would imply an accuracy the model lacks.
      for (const m of markups) {
        expect(Math.abs(m - markups[0])).toBeLessThanOrEqual(1); // rounding only
      }
    }
  });

  it('never lets shares exceed the whole', () => {
    for (const item of withVarieties) {
      const shown = (item.varieties ?? []).reduce((sum, v) => sum + v.share_percent, 0);
      expect(shown).toBeLessThanOrEqual(100);
    }
  });
});
