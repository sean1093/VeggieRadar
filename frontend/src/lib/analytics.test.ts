import { afterEach, describe, expect, it, vi } from 'vitest';
import { ageBucket, countBucket, track } from './analytics';

const g = globalThis as { gtag?: unknown };

describe('track', () => {
  afterEach(() => {
    delete g.gtag;
  });

  it('is a silent no-op when gtag is absent (tests, offline, ad blockers)', () => {
    expect(() => track('board_loaded', { source: 'network' })).not.toThrow();
  });

  it('forwards the event name and params to gtag', () => {
    const gtag = vi.fn();
    g.gtag = gtag;
    track('search_result', { outcome: 'local_hit', query_length: 3 });
    expect(gtag).toHaveBeenCalledWith('event', 'search_result', { outcome: 'local_hit', query_length: 3 });
  });

  it('defaults to empty params', () => {
    const gtag = vi.fn();
    g.gtag = gtag;
    track('chunk_failed');
    expect(gtag).toHaveBeenCalledWith('event', 'chunk_failed', {});
  });

  it('swallows a throwing gtag — analytics can never break the UI', () => {
    g.gtag = () => {
      throw new Error('blocked');
    };
    expect(() => track('board_fallback')).not.toThrow();
  });
});

describe('ageBucket', () => {
  const now = Date.parse('2026-09-02T12:00:00Z');

  it('buckets by hours since generated_at', () => {
    expect(ageBucket('2026-09-02T11:30:00Z', now)).toBe('<1h');
    expect(ageBucket('2026-09-02T08:00:00Z', now)).toBe('1-6h');
    expect(ageBucket('2026-09-01T20:00:00Z', now)).toBe('6-24h');
    expect(ageBucket('2026-08-30T12:00:00Z', now)).toBe('>24h');
  });

  it('reports unknown for a missing or unparsable timestamp', () => {
    expect(ageBucket(undefined, now)).toBe('unknown');
    expect(ageBucket('yesterday', now)).toBe('unknown');
  });
});

describe('countBucket', () => {
  it('keeps counts coarse', () => {
    expect(countBucket(0)).toBe('0');
    expect(countBucket(1)).toBe('1-3');
    expect(countBucket(3)).toBe('1-3');
    expect(countBucket(4)).toBe('4-10');
    expect(countBucket(10)).toBe('4-10');
    expect(countBucket(11)).toBe('>10');
  });
});
