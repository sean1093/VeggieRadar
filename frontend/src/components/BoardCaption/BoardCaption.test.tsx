import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import BoardCaption from './BoardCaption';

/** jsdom's `navigator.onLine` is a getter, so it is replaced, not assigned. */
function setOnLine(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

const DEGRADED = {
  title: '今日菜價',
  date: '2026-09-02',
  freshness: { note: null, checkedAt: '09/02 16:05' },
  degradedReason: '目前連不上伺服器，顯示最近一次的價格',
  searching: false,
};

describe('BoardCaption', () => {
  afterEach(() => setOnLine(true));

  it('offers a plain retry while the device has a connection', () => {
    render(<BoardCaption {...DEGRADED} onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: '重試' })).toBeInTheDocument();
  });

  it('says 離線中 instead of promising a retry that cannot work', () => {
    setOnLine(false);
    render(<BoardCaption {...DEGRADED} onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: '離線中' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重試' })).not.toBeInTheDocument();
  });

  it('stays tappable offline — `onLine` describes the interface, not the internet', () => {
    setOnLine(false);
    const onRetry = vi.fn();
    render(<BoardCaption {...DEGRADED} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: '離線中' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('follows the connection while on screen', () => {
    render(<BoardCaption {...DEGRADED} onRetry={vi.fn()} />);
    act(() => {
      setOnLine(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('button', { name: '離線中' })).toBeInTheDocument();

    act(() => {
      setOnLine(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByRole('button', { name: '重試' })).toBeInTheDocument();
  });

  it('has no retry to label when the board is current', () => {
    render(<BoardCaption {...DEGRADED} degradedReason={null} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
