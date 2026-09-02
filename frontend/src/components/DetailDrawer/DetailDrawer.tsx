import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import ProduceTrendChart from '../ProduceTrendChart/ProduceTrendChart';
import type { ProduceItem } from '../../types/produce';
import { fetchProduceTrend } from '../../services/api';
import { marketPrice } from '../../lib/utils/market-price';

interface DetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  item: ProduceItem;
  allProduceItems: ProduceItem[];
  watched?: boolean;
  onToggleWatch?: (item: ProduceItem) => void;
}

const DetailDrawer: React.FC<DetailDrawerProps> = ({ isOpen, onClose, item, allProduceItems, watched = false, onToggleWatch }) => {
  const [trendData, setTrendData] = useState<number[]>([]);
  const [trendLoading, setTrendLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !item?.official_name) {
      setTrendData([]);
      return;
    }
    setTrendLoading(true);
    fetchProduceTrend(item.official_name, 7)
      .then(setTrendData)
      .finally(() => setTrendLoading(false));
  }, [isOpen, item?.official_name]);

  const down = item.change_percent < 0;
  const tone = down ? 'text-sage' : 'text-clay';
  const arrow = down ? '↓' : '↑';
  // Estimated traditional-market price leads; the measured wholesale price and
  // the derivation move into the supporting block below it.
  const marketMid = marketPrice(item);
  // Variety breakdown rows plus the share they cover. Sub-threshold varieties
  // (and any capped beyond the top four) are folded away by the backend; when
  // the visible rows cover ≤90% of traded volume, the remainder is disclosed
  // instead of letting the list imply completeness.
  const varieties = item.varieties ?? [];
  const shownShare = varieties.reduce((sum, v) => sum + v.share_percent, 0);

  // Alternatives are ranked on the same basis as the headline — what the shopper
  // pays. Ranking on wholesale would recommend items that are cheaper at the
  // auction yet dearer at the stall, because stall markups differ per crop.
  const onMarketBasis = marketMid != null;
  const basePrice = marketMid ?? item.catty_price;
  const suggestions = allProduceItems
    .flatMap((p) => {
      if (p.category !== item.category || p.code === item.code) return [];
      const price = onMarketBasis ? marketPrice(p) : p.catty_price;
      return price != null && price < basePrice ? [{ item: p, price }] : [];
    })
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent data-testid="detail-drawer" className="max-h-[85vh] overflow-y-auto text-ink">
        <DialogHeader className="text-left">
          <div className="flex items-start justify-between gap-3">
            <DialogTitle className="text-2xl font-semibold tracking-tight">{item.name}</DialogTitle>
            {onToggleWatch && (
              <button
                type="button"
                onClick={() => onToggleWatch(item)}
                aria-pressed={watched}
                aria-label={watched ? `取消關注 ${item.name}` : `關注 ${item.name}`}
                className={`-m-1 p-1 text-2xl leading-none transition-colors ${watched ? 'text-sage' : 'text-line hover:text-stone'}`}
              >
                {watched ? '★' : '☆'}
              </button>
            )}
          </div>
          <DialogDescription className="text-sm text-stone">
            {item.category}
            {item.markets_count ? `・${item.markets_count} 個市場均價` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Price */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-stone">{marketMid != null ? '菜市場參考價' : '批發收盤均價'}</p>
              <p className="mt-1 leading-none">
                <span className="text-3xl font-semibold tabular-nums">
                  {marketMid != null ? `約 ${marketMid}` : item.catty_price.toFixed(1)}
                </span>
                <span className="ml-1 text-sm text-stone">元/台斤</span>
              </p>
              <p className="mt-1 text-xs text-stone tabular-nums">
                {marketMid != null
                  ? `區間 ${item.retail_low}–${item.retail_high} 元/台斤`
                  : `約 ${item.avg_price.toFixed(1)} 元/公斤`}
              </p>
            </div>
            <div>
              <p className="text-xs text-stone">批發較昨日</p>
              <p className={`mt-1 text-3xl font-semibold tabular-nums leading-none ${tone}`}>
                {arrow} {Math.abs(item.change_percent).toFixed(1)}%
              </p>
              <p className="mt-1 text-xs text-stone">{down ? '便宜了，可以多買' : '變貴了，可考慮替代'}</p>
            </div>
          </div>

          {/* Wholesale anchor + how the market estimate is derived from it */}
          {marketMid != null && (
            <div className="rounded-xl bg-sage-soft/50 px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs text-stone">批發收盤均價</p>
                <p className="leading-none text-ink">
                  <span className="text-2xl font-semibold tabular-nums">{item.catty_price.toFixed(1)}</span>
                  <span className="ml-1 text-sm text-stone">元/台斤</span>
                </p>
              </div>
              <p className="mt-1 text-right text-xs text-stone tabular-nums">約 {item.avg_price.toFixed(1)} 元/公斤</p>
              <p className="mt-2 text-xs leading-relaxed text-stone">
                菜市場價以批發價加上攤販常見加成推估（此品項約 +{Math.round(marketMid - item.catty_price)} 元/台斤），
                非實際報價。實測落在 {item.retail_low}–{item.retail_high} 元的機率約八成，買到低於 {item.retail_low} 元就算便宜。
              </p>
            </div>
          )}
          {/* Per-variety wholesale breakdown — present only when the blended
              average hides meaningful spread (e.g. 綠竹筍 at 2.5× 麻竹筍). */}
          {varieties.length > 0 && (
            <div>
              <p className="mb-2 text-xs text-stone">今日品種行情（批發・元/台斤）</p>
              <div className="space-y-1">
                {varieties.map((v) => (
                  <div key={v.name} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 break-words text-ink">{v.name}</span>
                    <span className="shrink-0 whitespace-nowrap tabular-nums text-ink">
                      {v.catty_price.toFixed(1)}
                      <span className="ml-2 text-xs text-stone">量 {v.share_percent}%</span>
                    </span>
                  </div>
                ))}
              </div>
              {shownShare <= 90 && (
                <p className="mt-1 text-xs text-stone">其餘品種合計約佔 {100 - shownShare}%</p>
              )}
            </div>
          )}

          {/* 7-day trend */}
          <div>
            <p className="mb-2 text-xs text-stone">近 7 日價格趨勢（元/公斤）</p>
            {trendLoading ? (
              <div className="py-6 text-center text-sm text-stone">載入中…</div>
            ) : trendData.length ? (
              <ProduceTrendChart trend={trendData} />
            ) : (
              <div className="py-6 text-center text-sm text-stone">暫無趨勢資料</div>
            )}
            {item.baseline_price != null && item.vs_baseline_percent != null && (
              <p className="mt-2 text-xs text-stone">
                近一個月批發中位約 {item.baseline_price} 元/台斤，今日批發
                {item.vs_baseline_percent < 0
                  ? `低 ${Math.round(Math.abs(item.vs_baseline_percent))}%`
                  : item.vs_baseline_percent > 0
                    ? `高 ${Math.round(item.vs_baseline_percent)}%`
                    : '持平'}
                ；卡片徽章與「划算優先」排序以此為準。
              </p>
            )}
          </div>

          {/* Details */}
          <div className="flex justify-between border-t border-line pt-4 text-sm text-stone">
            <span>分類：{item.category}</span>
            <span>交易量：{item.trade_volume.toLocaleString()} 公斤</span>
          </div>

          {/* Alternatives */}
          {suggestions.length > 0 && (
            <div className="border-t border-line pt-4">
              <p className="mb-3 text-sm font-medium text-ink">同類更划算的選擇</p>
              <div className="space-y-2">
                {suggestions.map(({ item: s, price }) => (
                  <div key={`${s.code}-${s.name}`} className="flex items-center justify-between rounded-xl bg-sage-soft/50 px-4 py-3">
                    <span className="font-medium text-ink">{s.name}</span>
                    <div className="text-right">
                      <p className="font-semibold text-sage tabular-nums">
                        {onMarketBasis ? `約 ${price}` : price.toFixed(1)} 元/台斤
                      </p>
                      <p className="text-xs text-stone tabular-nums">
                        省 {onMarketBasis ? basePrice - price : (basePrice - price).toFixed(1)} 元/台斤
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default DetailDrawer;
