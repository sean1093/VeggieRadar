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

interface DetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  item: ProduceItem;
  allProduceItems: ProduceItem[];
}

const DetailDrawer: React.FC<DetailDrawerProps> = ({ isOpen, onClose, item, allProduceItems }) => {
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

  // Alternative suggestions: same category, cheaper or falling in price.
  const suggestions = allProduceItems
    .filter(
      (p) =>
        p.category === item.category &&
        p.code !== item.code &&
        (p.avg_price < item.avg_price || p.change_percent < 0),
    )
    .sort((a, b) => a.avg_price - b.avg_price)
    .slice(0, 3);

  const down = item.change_percent < 0;
  const changeColor = down ? 'text-green-600' : 'text-red-600';
  const changeIcon = down ? '↓' : '↑';

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent data-testid="detail-drawer" className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-3xl">{item.name}</DialogTitle>
          <DialogDescription className="text-base">
            {item.category}
            {item.official_name !== item.name ? ` • ${item.official_name}` : ''}
            {item.markets_count ? ` • ${item.markets_count} 個市場均價` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Price */}
          <div className="bg-gray-50 p-4 rounded-lg grid grid-cols-2 gap-3">
            <div>
              <p className="text-sm text-gray-600">今日價格</p>
              <p className="text-3xl font-bold">{item.catty_price.toFixed(1)} <span className="text-base font-normal text-gray-500">元/台斤</span></p>
              <p className="text-xs text-gray-500">約 {item.avg_price.toFixed(1)} 元/公斤</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">與昨日相比</p>
              <p className={`text-3xl font-bold ${changeColor}`}>
                {changeIcon} {Math.abs(item.change_percent).toFixed(1)}%
              </p>
              <p className="text-xs text-gray-500">{down ? '便宜了，可以多買' : '變貴了，可考慮替代'}</p>
            </div>
          </div>

          {/* 7-day trend */}
          <div className="bg-gray-50 p-4 rounded-lg">
            <h3 className="font-semibold text-lg mb-2">7日價格趨勢（元/公斤）</h3>
            {trendLoading ? (
              <div className="text-center text-gray-500 text-sm py-6">載入趨勢資料中…</div>
            ) : trendData.length ? (
              <ProduceTrendChart trend={trendData} />
            ) : (
              <div className="text-center text-gray-400 text-sm py-6">暫無趨勢資料</div>
            )}
          </div>

          {/* Details */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            <p><span className="text-gray-600">分類：</span>{item.category}</p>
            <p><span className="text-gray-600">交易量：</span>{item.trade_volume.toLocaleString()} 公斤</p>
          </div>

          {/* Alternatives */}
          {suggestions.length > 0 && (
            <div className="border-t pt-4">
              <h3 className="font-semibold text-lg mb-3">💡 同類更划算的選擇</h3>
              <div className="space-y-2">
                {suggestions.map((s) => (
                  <div key={`${s.code}-${s.name}`} className="bg-green-50 p-3 rounded-lg flex justify-between items-center">
                    <p className="font-semibold">{s.name}</p>
                    <div className="text-right">
                      <p className="font-bold text-green-600">{s.catty_price.toFixed(1)} 元/台斤</p>
                      <p className="text-xs text-gray-600">省 {(item.catty_price - s.catty_price).toFixed(1)} 元/台斤</p>
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
