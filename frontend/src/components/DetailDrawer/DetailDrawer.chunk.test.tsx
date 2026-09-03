/**
 * What happens when the on-demand chart module fails to arrive — offline, or a
 * deploy that replaced the chunk mid-session.
 *
 * This is the regression guard for the reason the drawer imports the chart
 * manually instead of through `React.lazy`: `lazy` caches the rejected promise
 * and re-throws on every later render, and with no error boundary above the
 * drawer that would unmount the whole board. A failed chart must cost the
 * chart and nothing else.
 *
 * Split into its own file because it needs a module registry where the chart
 * module is rejected before `DetailDrawer` is first imported.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProduceItem } from '../../types/produce';

const item: ProduceItem = {
  code: 'LA', name: '高麗菜', official_name: '甘藍', category: '葉菜類',
  avg_price: 25.4, catty_price: 15.2, change_percent: -12.5,
  retail_low: 35, retail_price: 44, retail_high: 55, retail_estimated: true,
  trade_volume: 5000, unit: '公斤', markets_count: 6,
};

beforeEach(() => {
  vi.resetModules();
  vi.doMock('../../services/api', () => ({
    fetchProduceTrend: vi.fn(async () => [23.1, 24, 22.5]),
  }));
  vi.doMock('../ProduceTrendChart/ProduceTrendChart', () => {
    throw new Error('Failed to fetch dynamically imported module');
  });
});

afterEach(() => {
  vi.doUnmock('../ProduceTrendChart/ProduceTrendChart');
  vi.doUnmock('../../services/api');
});

describe('DetailDrawer — chart chunk failure', () => {
  it('degrades to a chart-local message and keeps the prices on screen', async () => {
    // Dynamic import is required: the mocks above must be registered before
    // this module graph is first evaluated.
    const { default: DetailDrawer } = await import('./DetailDrawer');

    render(<DetailDrawer isOpen onClose={() => {}} item={item} allProduceItems={[item]} />);

    expect(await screen.findByText('趨勢圖載入失敗')).toBeInTheDocument();
    // The reason this test exists: everything the shopper opened the drawer
    // for is still rendered.
    expect(screen.getByText('高麗菜')).toBeInTheDocument();
    expect(screen.getByText('菜市場參考價')).toBeInTheDocument();
    expect(screen.getByText('約 44')).toBeInTheDocument();
  });

  it('keeps the failed state at the chart height so nothing shifts', async () => {
    const { default: DetailDrawer } = await import('./DetailDrawer');
    render(<DetailDrawer isOpen onClose={() => {}} item={item} allProduceItems={[item]} />);

    expect(await screen.findByText('趨勢圖載入失敗')).toHaveClass('h-16');
  });
});
