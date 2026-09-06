import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useWatchlist } from './useWatchlist';

const KEY = 'veggie:watchlist:v1';

describe('useWatchlist', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('toggles membership and reports count', () => {
    const { result } = renderHook(() => useWatchlist());
    expect(result.current.isWatched('甘藍')).toBe(false);

    act(() => result.current.toggle('甘藍'));
    expect(result.current.isWatched('甘藍')).toBe(true);
    expect(result.current.count).toBe(1);

    act(() => result.current.toggle('甘藍'));
    expect(result.current.isWatched('甘藍')).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it('reports toggles as usage — a count bucket, never the produce name', () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const { result } = renderHook(() => useWatchlist());
    act(() => result.current.toggle('甘藍'));
    expect(gtag).toHaveBeenCalledWith('event', 'watch_toggled', { on: true, count_bucket: '1-3' });
    act(() => result.current.toggle('甘藍'));
    expect(gtag).toHaveBeenLastCalledWith('event', 'watch_toggled', { on: false, count_bucket: '0' });
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('甘藍');
  });

  it('persists to localStorage', () => {
    const { result } = renderHook(() => useWatchlist());
    act(() => result.current.toggle('番茄'));
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toContain('番茄');
  });

  it('loads a persisted list on mount', () => {
    localStorage.setItem(KEY, JSON.stringify(['蔥']));
    const { result } = renderHook(() => useWatchlist());
    expect(result.current.isWatched('蔥')).toBe(true);
  });

  it('tolerates corrupt storage', () => {
    localStorage.setItem(KEY, '{not json');
    const { result } = renderHook(() => useWatchlist());
    expect(result.current.count).toBe(0);
  });
});
