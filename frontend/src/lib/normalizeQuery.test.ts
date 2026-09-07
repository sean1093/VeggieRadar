/**
 * The fixture is `shared/normalize-query.fixture.json`, and
 * `frontend/backendCode.test.ts` runs the very same file against the Apps
 * Script implementation. That is the point: two implementations of one
 * contract only stay in step if one set of cases judges both.
 */
import { describe, it, expect } from 'vitest';
import { normalizeQuery, searchTerms } from './normalizeQuery';
import fixture from '../../../shared/normalize-query.fixture.json';
import table from '../../../shared/search-aliases.json';

const aliases: Record<string, string> = table.aliases;

describe('normalizeQuery — the shared fixture', () => {
  it.each(fixture)('$in → $out', ({ in: input, out }) => {
    expect(normalizeQuery(input)).toBe(out);
  });
});

describe('normalizeQuery — invariants the tables have to keep', () => {
  it('is idempotent: normalising a normalised query changes nothing', () => {
    // Otherwise the alias table would contain a chain, and which end of it a
    // query landed on would depend on how many passes ran.
    for (const { in: input } of fixture) {
      expect(normalizeQuery(normalizeQuery(input))).toBe(normalizeQuery(input));
    }
    for (const key of Object.keys(aliases)) {
      expect(normalizeQuery(aliases[key])).toBe(aliases[key]);
    }
  });

  it('resolves every alias key, so no entry in the table is unreachable', () => {
    for (const key of Object.keys(aliases)) {
      expect(normalizeQuery(key), key).toBe(aliases[key]);
    }
  });

  it('has no alias key that suffix-stripping would eat first', () => {
    // Stripping runs before the lookup, so a key ending in 「菜價」 or 「元」
    // could never be hit — a silent hole rather than a test failure.
    for (const key of Object.keys(aliases)) {
      for (const suffix of table.suffixes) {
        expect(key.endsWith(suffix) && key.length > suffix.length, `${key} ends with ${suffix}`).toBe(false);
      }
    }
  });
});

describe('searchTerms', () => {
  it('keeps the typed form beside the MOA root, because they match different rows', () => {
    // 「蔥」 is on the board by name while its alias 青蔥 is the root of 蔥 and
    // 紅蔥頭; dropping either term loses items the shopper expects.
    expect(searchTerms('蔥')).toEqual(['蔥', '青蔥']);
    expect(searchTerms('高麗菜多少錢')).toEqual(['高麗菜', '甘藍']);
  });

  it('collapses to one term when the query is already canonical', () => {
    expect(searchTerms('甘藍')).toEqual(['甘藍']);
    expect(searchTerms('xyz')).toEqual(['xyz']);
  });
});
