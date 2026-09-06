/**
 * How a retail quote and a wholesale day become one markup observation.
 */
import { describe, it, expect } from 'vitest';
import { retailMeans, defsForQuotes } from '../src/join.ts';
import type { RetailQuote } from '../src/sources/taichung.ts';

describe('retail means', () => {
  it('averages every stall surveyed for one root on one day', () => {
    const quotes: RetailQuote[] = [
      { date: '2026-09-01', root: '甘藍', price: 27 },
      { date: '2026-09-01', root: '甘藍', price: 30 },
      { date: '2026-09-01', root: '甘藍', price: 66 },
      { date: '2026-09-02', root: '甘藍', price: 40 },
    ];
    const means = retailMeans(quotes);
    expect(means['甘藍\u00002026-09-01']).toBe(41);
    expect(means['甘藍\u00002026-09-02']).toBe(40);
  });

  it('pools the cultivar columns that share a root', () => {
    // Four pineapple columns are evidence about one markup, because the runtime
    // markup is keyed by root and applied to the root's blended wholesale.
    const quotes: RetailQuote[] = [
      { date: '2026-05-01', root: '鳳梨', price: 40 },
      { date: '2026-05-01', root: '鳳梨', price: 50 },
      { date: '2026-05-01', root: '鳳梨', price: 60 },
    ];
    expect(retailMeans(quotes)['鳳梨\u00002026-05-01']).toBe(50);
  });

  it('keeps roots and dates apart', () => {
    const means = retailMeans([
      { date: '2026-09-01', root: '甘藍', price: 30 },
      { date: '2026-09-01', root: '蕹菜', price: 45 },
    ]);
    expect(Object.keys(means)).toHaveLength(2);
  });
});

describe('the def each root is joined against', () => {
  it('resolves one def per root from the feeds\' variety hints', () => {
    const defs = defsForQuotes([
      { date: '2026-09-01', root: '雜柑', item: '檸檬', price: 45 },
      { date: '2026-09-02', root: '雜柑', item: '檸檬', price: 47 },
      { date: '2026-09-01', root: '甘藍', price: 30 },
    ]);
    expect(defs['雜柑'].variety).toBe('檸檬');
    expect(defs['甘藍'].official).toBe('甘藍');
    expect(defs['甘藍'].variety).toBeUndefined();
  });

  it('refuses two different hints for one root instead of letting the last win', () => {
    expect(() => defsForQuotes([
      { date: '2026-09-01', root: '甜椒', item: '青椒', price: 100 },
      { date: '2026-09-01', root: '甜椒', item: '甜椒', price: 200 },
    ])).toThrow(/conflicting variety hints/);
  });
});
