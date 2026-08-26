import { describe, it, expect } from 'vitest';
import { getAlternativeSuggestions } from './produce-suggestions';
import type { ProduceItem } from '../../types/produce';

const item = (over: Partial<ProduceItem> & Pick<ProduceItem, 'code' | 'name' | 'category' | 'avg_price' | 'change_percent'>): ProduceItem => ({
  official_name: over.name,
  catty_price: Math.round(over.avg_price * 0.6 * 10) / 10,
  trade_volume: 1000,
  unit: '公斤',
  markets_count: 5,
  ...over,
});

const mockAllProduceItems: ProduceItem[] = [
  item({ code: 'LA1', name: '高麗菜', avg_price: 50.0, change_percent: 20.0, category: '葉菜類' }),
  item({ code: 'LA2', name: '小白菜', avg_price: 20.0, change_percent: -5.0, category: '葉菜類' }),
  item({ code: 'LA3', name: '菠菜', avg_price: 25.0, change_percent: -10.0, category: '葉菜類' }),
  item({ code: 'RA1', name: '馬鈴薯', avg_price: 30.0, change_percent: 5.0, category: '根莖類' }),
  item({ code: 'RA2', name: '地瓜', avg_price: 28.0, change_percent: -2.0, category: '根莖類' }),
  item({ code: 'F1', name: '蘋果', avg_price: 100.0, change_percent: 1.0, category: '水果' }),
];

describe('getAlternativeSuggestions', () => {
  it('returns cheaper alternatives from the same category when item has high price increase', () => {
    const itemWithHighIncrease = mockAllProduceItems[0]; // 高麗菜, 20% increase
    const suggestions = getAlternativeSuggestions(itemWithHighIncrease, mockAllProduceItems, 10);

    expect(suggestions).toHaveLength(2);
    expect(suggestions.some((s) => s.name === '小白菜')).toBe(true);
    expect(suggestions.some((s) => s.name === '菠菜')).toBe(true);
    expect(suggestions.some((s) => s.name === '馬鈴薯')).toBe(false);
    expect(suggestions.every((s) => s.category === itemWithHighIncrease.category)).toBe(true);
    expect(suggestions.every((s) => s.avg_price < itemWithHighIncrease.avg_price)).toBe(true);
    expect(suggestions.every((s) => s.change_percent <= itemWithHighIncrease.change_percent)).toBe(true);
  });

  it('returns no suggestions if the item itself does not have a high price increase', () => {
    const suggestions = getAlternativeSuggestions(mockAllProduceItems[3], mockAllProduceItems, 10);
    expect(suggestions).toHaveLength(0);
  });

  it('returns no suggestions if no cheaper alternatives exist in the same category', () => {
    const itemWithHighIncrease = item({ code: 'LA1', name: '高麗菜', avg_price: 10.0, change_percent: 15.0, category: '葉菜類' });
    const moreExpensiveItem = item({ code: 'LA4', name: '大白菜', avg_price: 12.0, change_percent: 5.0, category: '葉菜類' });
    const suggestions = getAlternativeSuggestions(itemWithHighIncrease, [itemWithHighIncrease, moreExpensiveItem], 10);
    expect(suggestions).toHaveLength(0);
  });

  it('returns no suggestions if no other items in the same category', () => {
    const rare = item({ code: 'LAX', name: '高麗菜', avg_price: 50.0, change_percent: 20.0, category: '稀有菜' });
    const suggestions = getAlternativeSuggestions(rare, mockAllProduceItems, 10);
    expect(suggestions).toHaveLength(0);
  });
});
