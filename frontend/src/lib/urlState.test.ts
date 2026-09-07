import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  itemUrl,
  parseUrlState,
  pushUrlState,
  replaceUrlState,
  serializeUrlState,
  type UrlState,
} from './urlState';

const BOARD: UrlState = { item: null, query: '', filter: 'all', sort: null };
const at = (hash: string) => window.history.replaceState(null, '', `/VeggieRadar/${hash}`);

describe('parseUrlState', () => {
  it('reads the board from every shape of empty hash', () => {
    expect(parseUrlState('')).toEqual(BOARD);
    expect(parseUrlState('#')).toEqual(BOARD);
    expect(parseUrlState('#/')).toEqual(BOARD);
  });

  it('reads an item by display name, encoded or not', () => {
    // Browsers and chat apps disagree on whether a hash stays percent-encoded.
    expect(parseUrlState('#/i/%E9%AB%98%E9%BA%97%E8%8F%9C').item).toBe('高麗菜');
    expect(parseUrlState('#/i/高麗菜').item).toBe('高麗菜');
  });

  it('reads a query, a filter and an order', () => {
    expect(parseUrlState('#/?q=蔥')).toEqual({ ...BOARD, query: '蔥' });
    expect(parseUrlState('#/?f=葉菜類&sort=value')).toEqual({ ...BOARD, filter: '葉菜類', sort: 'value' });
    expect(parseUrlState('#/?f=watch')).toEqual({ ...BOARD, filter: 'watch' });
  });

  it('reads an item that a query or filter is showing under it', () => {
    expect(parseUrlState('#/i/蔥?q=蔥&f=辛香類')).toEqual({
      item: '蔥',
      query: '蔥',
      filter: '辛香類',
      sort: null,
    });
  });

  it('falls back to the defaults for values it cannot honour', () => {
    // An unknown order would otherwise sort the board by nothing, an empty
    // name would open an empty drawer, and a clipped escape would throw.
    expect(parseUrlState('#/?sort=foo').sort).toBeNull();
    expect(parseUrlState('#/i/').item).toBeNull();
    expect(parseUrlState('#/i/%E9%AB').item).toBeNull();
    expect(parseUrlState('#/?f=').filter).toBe('all');
    expect(parseUrlState('#/?q=%20%20').query).toBe('');
    expect(parseUrlState('#/board/i/高麗菜').item).toBeNull();
  });
});

describe('serializeUrlState', () => {
  it('writes the four documented shapes', () => {
    expect(serializeUrlState(BOARD)).toBe('#/');
    expect(serializeUrlState({ ...BOARD, item: '高麗菜' })).toBe('#/i/%E9%AB%98%E9%BA%97%E8%8F%9C');
    expect(serializeUrlState({ ...BOARD, query: '蔥' })).toBe('#/?q=%E8%94%A5');
    expect(serializeUrlState({ ...BOARD, filter: '葉菜類', sort: 'value' })).toBe(
      '#/?f=%E8%91%89%E8%8F%9C%E9%A1%9E&sort=value',
    );
    expect(serializeUrlState({ ...BOARD, filter: 'watch' })).toBe('#/?f=watch');
  });

  it('round-trips every state through the hash', () => {
    const states: UrlState[] = [
      BOARD,
      { ...BOARD, item: '高麗菜' },
      { ...BOARD, query: '蔥' },
      { ...BOARD, filter: '葉菜類', sort: 'value' },
      { ...BOARD, filter: 'watch', sort: 'category' },
      { item: '蔥', query: '蔥', filter: '辛香類', sort: 'value' },
      // Names that would break a naive split on the route separators.
      { ...BOARD, item: '茼蒿?/#' },
    ];
    for (const state of states) {
      expect(parseUrlState(serializeUrlState(state))).toEqual(state);
    }
  });
});

describe('itemUrl', () => {
  it('links to the item alone, not to how the sharer was reading the board', () => {
    at('#/?f=葉菜類&sort=value');
    expect(itemUrl('高麗菜')).toBe('http://localhost:3000/VeggieRadar/#/i/%E9%AB%98%E9%BA%97%E8%8F%9C');
  });
});

describe('pushUrlState / replaceUrlState', () => {
  let start = 0;

  beforeEach(() => {
    at('#/');
    start = window.history.length;
  });

  afterEach(() => at('#/'));

  it('gives the drawer a history entry so the back key can close it', () => {
    pushUrlState({ item: '高麗菜' });
    expect(window.location.hash).toBe('#/i/%E9%AB%98%E9%BA%97%E8%8F%9C');
    expect(window.history.length).toBe(start + 1);
  });

  it('merges the patch over the current URL, so a drawer keeps its search', () => {
    replaceUrlState({ query: '蔥' });
    pushUrlState({ item: '蔥' });
    expect(parseUrlState(window.location.hash)).toEqual({ ...BOARD, item: '蔥', query: '蔥' });
  });

  it('rewrites the current entry for filter and sort', () => {
    replaceUrlState({ filter: '葉菜類' });
    replaceUrlState({ sort: 'value' });
    expect(window.location.hash).toBe('#/?f=%E8%91%89%E8%8F%9C%E9%A1%9E&sort=value');
    expect(window.history.length).toBe(start);
  });

  it('keeps the deployment path and the campaign parameters of the visit', () => {
    window.history.replaceState(null, '', '/VeggieRadar/?utm_source=line#/');
    replaceUrlState({ filter: 'watch' });
    expect(window.location.pathname + window.location.search).toBe('/VeggieRadar/?utm_source=line');
  });

  it('writes nothing when the state already matches the URL', () => {
    pushUrlState({ item: '高麗菜' });
    pushUrlState({ item: '高麗菜' });
    expect(window.history.length).toBe(start + 1);
  });
});
