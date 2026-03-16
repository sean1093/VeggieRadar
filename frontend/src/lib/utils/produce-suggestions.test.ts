import { describe, it, expect } from 'vitest';
import { getAlternativeSuggestions } from './produce-suggestions';
import type { ProduceItem } from '../../types/produce';

const mockAllProduceItems: ProduceItem[] = [
  { code: "LA1", name: "高麗菜", avg_price: 50.0, change_percent: 20.0, category: "葉菜類", origin: "", unit: "公斤", trade_volume: 1000, market: "台北一市", upper_price: 55.0, middle_price: 50.0, lower_price: 45.0 },
  { code: "LA2", name: "小白菜", avg_price: 20.0, change_percent: -5.0, category: "葉菜類", origin: "", unit: "公斤", trade_volume: 1000, market: "台北一市", upper_price: 22.0, middle_price: 20.0, lower_price: 18.0 },
  { code: "LA3", name: "菠菜", avg_price: 25.0, change_percent: -10.0, category: "葉菜類", origin: "", unit: "公斤", trade_volume: 1000, market: "台北一市", upper_price: 28.0, middle_price: 25.0, lower_price: 22.0 },
  { code: "RA1", name: "馬鈴薯", avg_price: 30.0, change_percent: 5.0, category: "根莖類", origin: "", unit: "公斤", trade_volume: 1000, market: "台北一市", upper_price: 33.0, middle_price: 30.0, lower_price: 27.0 },
  { code: "RA2", name: "地瓜", avg_price: 28.0, change_percent: -2.0, category: "根莖類", origin: "", unit: "公斤", trade_volume: 1000, market: "台北一市", upper_price: 30.0, middle_price: 28.0, lower_price: 26.0 },
  { code: "F1", name: "蘋果", avg_price: 100.0, change_percent: 1.0, category: "水果", origin: "", unit: "公斤", trade_volume: 1000, market: "台北一市", upper_price: 110.0, middle_price: 100.0, lower_price: 90.0 },
];

describe('getAlternativeSuggestions', () => {
  it('returns cheaper alternatives from the same category when item has high price increase', () => {
    const itemWithHighIncrease = mockAllProduceItems[0]; // 高麗菜, 20% increase
    const suggestions = getAlternativeSuggestions(itemWithHighIncrease, mockAllProduceItems, 10); // Threshold 10%

    expect(suggestions).toHaveLength(2); // Expecting 小白菜 and 菠菜
    expect(suggestions.some(s => s.name === '小白菜')).toBe(true);
    expect(suggestions.some(s => s.name === '菠菜')).toBe(true);
    expect(suggestions.some(s => s.name === '馬鈴薯')).toBe(false); // Not same category
    expect(suggestions.every(s => s.category === itemWithHighIncrease.category)).toBe(true);
    expect(suggestions.every(s => s.avg_price < itemWithHighIncrease.avg_price)).toBe(true);
    // Expecting alternatives to have lower or negative change_percent compared to the current item's high increase
    expect(suggestions.every(s => s.change_percent <= itemWithHighIncrease.change_percent)).toBe(true);
  });

  it('returns no suggestions if the item itself does not have a high price increase', () => {
    const itemNoHighIncrease = mockAllProduceItems[3]; // 馬鈴薯, 5% increase
    const suggestions = getAlternativeSuggestions(itemNoHighIncrease, mockAllProduceItems, 10);

    expect(suggestions).toHaveLength(0);
  });

  it('returns no suggestions if no cheaper alternatives exist in the same category', () => {
    const itemWithHighIncrease: ProduceItem = { ...mockAllProduceItems[0], avg_price: 10.0, change_percent: 15.0 };
    const moreExpensiveItem: ProduceItem = { code: "LA4", name: "大白菜", avg_price: 12.0, change_percent: 5.0, category: "葉菜類", origin: "", unit: "公斤", trade_volume: 1000, market: "台北一市", upper_price: 14.0, middle_price: 12.0, lower_price: 10.0 };
    const suggestions = getAlternativeSuggestions(itemWithHighIncrease, [
        itemWithHighIncrease,
        moreExpensiveItem
    ], 10);

    expect(suggestions).toHaveLength(0);
  });

  it('returns no suggestions if no other items in the same category', () => {
    const itemWithHighIncrease: ProduceItem = { ...mockAllProduceItems[0], code: "LAX", category: "稀有菜", change_percent: 20.0 };
    const suggestions = getAlternativeSuggestions(itemWithHighIncrease, mockAllProduceItems, 10);

    expect(suggestions).toHaveLength(0);
  });
});
