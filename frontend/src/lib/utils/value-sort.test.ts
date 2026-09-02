import { describe, it, expect } from 'vitest';
import { byValueFirst } from './value-sort';
import type { ProduceItem } from '../../types/produce';

const item = (name: string, vs?: number): ProduceItem => ({
  code: name,
  name,
  official_name: name,
  category: '葉菜類',
  avg_price: 20,
  catty_price: 12,
  change_percent: 0,
  trade_volume: 1000,
  unit: '公斤',
  markets_count: 5,
  ...(vs !== undefined ? { vs_baseline_percent: vs } : {}),
});

describe('byValueFirst', () => {
  it('puts the deepest discount first and premiums last', () => {
    const sorted = [item('a', 5), item('b', -25), item('c', -10)].sort(byValueFirst);
    expect(sorted.map((i) => i.name)).toEqual(['b', 'c', 'a']);
  });

  it('sinks missing baselines below every ranked item', () => {
    const sorted = [item('none'), item('cheap', -2)].sort(byValueFirst);
    expect(sorted.map((i) => i.name)).toEqual(['cheap', 'none']);
  });

  it('treats NaN as unrankable instead of poisoning the comparator', () => {
    // A NaN comparator result acts like 0 and leaves items floating wherever
    // the sort touches them; NaN must sink exactly like a missing value.
    const sorted = [item('nan', Number.NaN), item('cheap', -30), item('flat', 0)].sort(byValueFirst);
    expect(sorted.map((i) => i.name)).toEqual(['cheap', 'flat', 'nan']);
    expect(byValueFirst(item('nan', Number.NaN), item('none'))).toBe(0); // both sink, stable order
  });

  it('returns 0 for equal keys so the stable sort preserves curated order', () => {
    expect(byValueFirst(item('a', -10), item('b', -10))).toBe(0);
  });
});