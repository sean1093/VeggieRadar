import { describe, it, expect } from 'vitest';
import { marketPrice } from './market-price';
import type { ProduceItem } from '../../types/produce';

const base: ProduceItem = {
  code: 'LA', name: '高麗菜', official_name: '甘藍', category: '葉菜類',
  avg_price: 24.4, catty_price: 14.6, change_percent: -3.1,
  trade_volume: 416301, unit: '公斤', markets_count: 6,
};

describe('marketPrice', () => {
  it('uses the calibrated midpoint the backend ships', () => {
    expect(marketPrice({ ...base, retail_low: 35, retail_price: 44, retail_high: 55 })).toBe(44);
  });

  it('derives the midpoint from the band when the midpoint is missing', () => {
    expect(marketPrice({ ...base, retail_low: 35, retail_high: 56 })).toBe(46);
  });

  it('returns null for a cached board without retail fields', () => {
    expect(marketPrice(base)).toBeNull();
  });

  it('returns null when only one edge of the band is present', () => {
    expect(marketPrice({ ...base, retail_low: 35 })).toBeNull();
  });
});
