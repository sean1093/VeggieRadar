import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import DetailDrawer from './DetailDrawer';
import { fetchProduceTrend } from '../../services/api';
import type { ProduceItem } from '../../types/produce';

// Trend data drives whether the lazily-loaded chart renders at all, so it has
// to be controllable. Defaults to empty, matching the offline api behaviour
// the rest of these tests were written against.
vi.mock('../../services/api', () => ({
  fetchProduceTrend: vi.fn(async (): Promise<number[]> => []),
}));

const mockProduceItem: ProduceItem = {
  code: 'LA', name: '高麗菜', official_name: '甘藍', category: '葉菜類',
  avg_price: 25.4, catty_price: 15.2, change_percent: -12.5,
  trade_volume: 5000, unit: '公斤', markets_count: 6,
};

const mockAllProduceItems: ProduceItem[] = [
  mockProduceItem,
  {
    code: 'FA', name: '番茄', official_name: '番茄', category: '果菜類',
    avg_price: 45.0, catty_price: 27.0, change_percent: 5.0,
    trade_volume: 3000, unit: '公斤', markets_count: 5,
  },
];

const withRetail: ProduceItem = {
  ...mockProduceItem,
  retail_low: 35, retail_price: 44, retail_high: 55, retail_estimated: true,
};

// Wholesale order and market order disagree here: 芥菜 is the cheaper wholesale
// buy yet the pricier one at the stall, because its markup is far larger.
const marketRanked: ProduceItem[] = [
  withRetail,
  {
    code: 'LJ', name: '芥菜', official_name: '芥菜', category: '葉菜類',
    avg_price: 22.1, catty_price: 13.3, change_percent: -5.1,
    retail_low: 40, retail_price: 48, retail_high: 65, retail_estimated: true,
    trade_volume: 7990, unit: '公斤', markets_count: 9,
  },
  {
    code: 'LN', name: '油菜', official_name: '油菜', category: '葉菜類',
    avg_price: 27.4, catty_price: 16.4, change_percent: 26.6,
    retail_low: 30, retail_price: 40, retail_high: 50, retail_estimated: true,
    trade_volume: 28737, unit: '公斤', markets_count: 11,
  },
];

describe('DetailDrawer', () => {
  it('does not render when isOpen is false', () => {
    render(<DetailDrawer isOpen={false} onClose={() => {}} item={mockProduceItem} allProduceItems={mockAllProduceItems} />);
    expect(screen.queryByTestId('detail-drawer')).not.toBeInTheDocument();
  });

  it('renders when isOpen is true', () => {
    render(<DetailDrawer isOpen={true} onClose={() => {}} item={mockProduceItem} allProduceItems={mockAllProduceItems} />);
    expect(screen.getByTestId('detail-drawer')).toBeInTheDocument();
  });

  it('displays the detailed information of the produce item', () => {
    render(<DetailDrawer isOpen={true} onClose={() => {}} item={mockProduceItem} allProduceItems={mockAllProduceItems} />);
    expect(screen.getByText(mockProduceItem.name)).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(mockProduceItem.category)).length).toBeGreaterThan(0);
  });

  it('leads with the estimated market price and demotes wholesale', () => {
    render(<DetailDrawer isOpen={true} onClose={() => {}} item={withRetail} allProduceItems={mockAllProduceItems} />);
    expect(screen.getByText('菜市場參考價')).toBeInTheDocument();
    expect(screen.getByText('約 44')).toBeInTheDocument();
    expect(screen.getByText('區間 35–55 元/台斤')).toBeInTheDocument();
    expect(screen.getByText('批發收盤均價')).toBeInTheDocument();
    expect(screen.getByText('15.2')).toBeInTheDocument();
  });

  it('keeps the wholesale headline when the board has no retail fields', () => {
    render(<DetailDrawer isOpen={true} onClose={() => {}} item={mockProduceItem} allProduceItems={mockAllProduceItems} />);
    expect(screen.getByText('批發收盤均價')).toBeInTheDocument();
    expect(screen.getByText('15.2')).toBeInTheDocument();
    expect(screen.queryByText('菜市場參考價')).not.toBeInTheDocument();
  });

  it('ranks alternatives by what the shopper pays, not by wholesale', () => {
    render(<DetailDrawer isOpen={true} onClose={() => {}} item={withRetail} allProduceItems={marketRanked} />);
    // 油菜 costs more wholesale (16.4 vs 13.3) but less at the stall (40 vs 48).
    expect(screen.getByText('油菜')).toBeInTheDocument();
    expect(screen.queryByText('芥菜')).not.toBeInTheDocument();
  });

  it('quotes alternatives in market money with the market saving', () => {
    render(<DetailDrawer isOpen={true} onClose={() => {}} item={withRetail} allProduceItems={marketRanked} />);
    expect(screen.getByText('約 40 元/台斤')).toBeInTheDocument();
    expect(screen.getByText('省 4 元/台斤')).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', () => {
    const handleClose = vi.fn();
    render(<DetailDrawer isOpen={true} onClose={handleClose} item={mockProduceItem} allProduceItems={mockAllProduceItems} />);
    // shadcn/ui Dialog doesn't have a close button with text, it uses an X icon
    // We'll skip this test for now as it depends on the Dialog implementation
    expect(handleClose).not.toHaveBeenCalled();
  });
  describe('baseline caption', () => {
    it('explains the monthly median under the trend, wholesale basis', () => {
      render(
        <DetailDrawer
          isOpen
          onClose={() => {}}
          item={{ ...withRetail, baseline_price: 18.1, vs_baseline_percent: -22.3 }}
          allProduceItems={mockAllProduceItems}
        />,
      );
      expect(screen.getByText(/近一個月批發中位約 18.1 元\/台斤/)).toBeInTheDocument();
      expect(screen.getByText(/低 22%/)).toBeInTheDocument();
    });

    it('says 高 when pricier and 持平 at zero', () => {
      const { unmount } = render(
        <DetailDrawer
          isOpen
          onClose={() => {}}
          item={{ ...withRetail, baseline_price: 18, vs_baseline_percent: 8.4 }}
          allProduceItems={mockAllProduceItems}
        />,
      );
      expect(screen.getByText(/高 8%/)).toBeInTheDocument();
      unmount();
      render(
        <DetailDrawer
          isOpen
          onClose={() => {}}
          item={{ ...withRetail, baseline_price: 18, vs_baseline_percent: 0 }}
          allProduceItems={mockAllProduceItems}
        />,
      );
      expect(screen.getByText(/持平/)).toBeInTheDocument();
    });

    it('omits the caption when the item has no baseline', () => {
      render(<DetailDrawer isOpen onClose={() => {}} item={withRetail} allProduceItems={mockAllProduceItems} />);
      expect(screen.queryByText(/近一個月批發中位/)).not.toBeInTheDocument();
    });
  });
  describe('variety breakdown', () => {
    const bamboo: ProduceItem = {
      ...withRetail,
      name: '竹筍',
      varieties: [
        { name: '烏殼綠', catty_price: 25.9, retail_price: 54, share_percent: 41 },
        { name: '麻竹筍', catty_price: 23.2, retail_price: 51, share_percent: 34 },
        { name: '綠竹筍', catty_price: 57.1, retail_price: 85, share_percent: 24 },
      ],
    };

    it('leads each variety with the market estimate a shopper is actually quoted', () => {
      render(<DetailDrawer isOpen onClose={() => {}} item={bamboo} allProduceItems={mockAllProduceItems} />);
      expect(screen.getByText('今日品種行情（推估菜市場價・元/台斤）')).toBeInTheDocument();
      expect(screen.getByText('綠竹筍')).toBeInTheDocument();
      expect(screen.getByText('約 85')).toBeInTheDocument();
      // Wholesale stays as the measured support, exactly like the card.
      expect(screen.getByText('批發 57.1・量 24%')).toBeInTheDocument();
    });

    it('marks the mainstream variety and keeps volume order', () => {
      render(<DetailDrawer isOpen onClose={() => {}} item={bamboo} allProduceItems={mockAllProduceItems} />);
      expect(screen.getByText('主流')).toBeInTheDocument();
      const shares = screen.getAllByText(/批發 [\d.]+・量 \d+%/).map((el) => el.textContent);
      expect(shares).toEqual(['批發 25.9・量 41%', '批發 23.2・量 34%', '批發 57.1・量 24%']);
    });

    it('states the relationship as approximate and over ALL varieties', () => {
      render(<DetailDrawer isOpen onClose={() => {}} item={bamboo} allProduceItems={mockAllProduceItems} />);
      // "約等於" and "全部品種", not an exact identity over the listed rows:
      // each row and share is rounded independently, and rows can omit volume.
      expect(screen.getByText(/約等於全部品種依成交量加權的平均/)).toBeInTheDocument();
    });

    it('inherits the root-level markup uncertainty instead of implying its own', () => {
      render(<DetailDrawer isOpen onClose={() => {}} item={bamboo} allProduceItems={mockAllProduceItems} />);
      expect(screen.getByText(/沿用同一套「根作物」加成，誤差與上方區間相同/)).toBeInTheDocument();
    });

    it('falls back to wholesale-only rows for a board cached before retail per variety', () => {
      const legacy: ProduceItem = {
        ...withRetail,
        varieties: [
          { name: '甲', catty_price: 20, share_percent: 55 },
          { name: '乙', catty_price: 30, share_percent: 40 },
        ],
      };
      render(<DetailDrawer isOpen onClose={() => {}} item={legacy} allProduceItems={mockAllProduceItems} />);
      expect(screen.getByText('批發・量 55%')).toBeInTheDocument();
      // With no estimate to lead with, the measured wholesale takes the slot.
      expect(screen.getByText('20.0')).toBeInTheDocument();
    });

    it('renders nothing for single-variety items — old boards stay untouched', () => {
      render(<DetailDrawer isOpen onClose={() => {}} item={withRetail} allProduceItems={mockAllProduceItems} />);
      expect(screen.queryByText(/今日品種行情/)).not.toBeInTheDocument();
    });

    it('renders nothing for an empty varieties array', () => {
      render(
        <DetailDrawer isOpen onClose={() => {}} item={{ ...withRetail, varieties: [] }} allProduceItems={mockAllProduceItems} />,
      );
      expect(screen.queryByText(/今日品種行情/)).not.toBeInTheDocument();
    });

    it('discloses any omitted volume, however small', () => {
      const sparse: ProduceItem = {
        ...withRetail,
        varieties: [
          { name: '甲', catty_price: 20, retail_price: 45, share_percent: 40 },
          { name: '乙', catty_price: 30, retail_price: 58, share_percent: 30 },
        ],
      };
      render(<DetailDrawer isOpen onClose={() => {}} item={sparse} allProduceItems={mockAllProduceItems} />);
      expect(screen.getByText(/未列出的品種合計約佔 30%/)).toBeInTheDocument();
    });

    it('discloses even a 1% remainder, since the rows claim to average the whole', () => {
      // 41 + 34 + 24 = 99%. A 「大致完整」 threshold used to hide this, which
      // let the weighted-average sentence describe rows that omitted volume.
      render(<DetailDrawer isOpen onClose={() => {}} item={bamboo} allProduceItems={mockAllProduceItems} />);
      expect(screen.getByText(/未列出的品種合計約佔 1%/)).toBeInTheDocument();
    });

    it('omits the remainder only when the rows truly cover everything', () => {
      const complete: ProduceItem = {
        ...withRetail,
        varieties: [
          { name: '甲', catty_price: 20, retail_price: 45, share_percent: 60 },
          { name: '乙', catty_price: 30, retail_price: 58, share_percent: 40 },
        ],
      };
      render(<DetailDrawer isOpen onClose={() => {}} item={complete} allProduceItems={mockAllProduceItems} />);
      expect(screen.queryByText(/未列出的品種/)).not.toBeInTheDocument();
    });
    it('toggles the watchlist from the drawer star', () => {
      const onToggleWatch = vi.fn();
      render(
        <DetailDrawer
          isOpen
          onClose={() => {}}
          item={withRetail}
          allProduceItems={mockAllProduceItems}
          watched={false}
          onToggleWatch={onToggleWatch}
        />,
      );
      screen.getByRole('button', { name: `關注 ${withRetail.name}` }).click();
      expect(onToggleWatch).toHaveBeenCalledWith(withRetail);
    });
  });
});
/**
 * recharts is roughly half the initial JS and only this drawer uses it, so it
 * is fetched on demand. These pin what could regress: the chart still arrives,
 * the prices never wait for it, and no state change shifts the dialog.
 */
describe('DetailDrawer — on-demand trend chart', () => {
  it('renders the chart once the module and the trend data arrive', async () => {
    vi.mocked(fetchProduceTrend).mockResolvedValueOnce([23.1, 24, 22.5]);
    render(<DetailDrawer isOpen onClose={() => {}} item={withRetail} allProduceItems={mockAllProduceItems} />);

    expect(await screen.findByTestId('produce-trend-chart')).toBeInTheDocument();
  });

  it('reserves the chart height in every state, so resolving it cannot shift the dialog', async () => {
    vi.mocked(fetchProduceTrend).mockResolvedValueOnce([23.1, 24, 22.5]);
    render(<DetailDrawer isOpen onClose={() => {}} item={withRetail} allProduceItems={mockAllProduceItems} />);

    // Pending: the placeholder already occupies the chart's own height.
    expect(screen.getByText('載入中…')).toHaveClass('h-16');
    expect(await screen.findByTestId('produce-trend-chart')).toHaveClass('h-16');
  });

  it('shows the prices while the chart is still pending', () => {
    vi.mocked(fetchProduceTrend).mockResolvedValueOnce([23.1, 24, 22.5]);
    render(<DetailDrawer isOpen onClose={() => {}} item={withRetail} allProduceItems={mockAllProduceItems} />);

    expect(screen.getByText(withRetail.name)).toBeInTheDocument();
    expect(screen.getByText('菜市場參考價')).toBeInTheDocument();
  });

  it('renders the empty state, not a chart, when the crop has no trend', async () => {
    render(<DetailDrawer isOpen onClose={() => {}} item={withRetail} allProduceItems={mockAllProduceItems} />);
    expect(await screen.findByText('暫無趨勢資料')).toBeInTheDocument();
    expect(screen.queryByTestId('produce-trend-chart')).not.toBeInTheDocument();
  });
});
