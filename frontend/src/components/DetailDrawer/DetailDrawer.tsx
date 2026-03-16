import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ProduceItem } from '../../types/produce';

interface DetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  item: ProduceItem;
  allProduceItems: ProduceItem[];
}

const DetailDrawer: React.FC<DetailDrawerProps> = ({ isOpen, onClose, item, allProduceItems }) => {
  // Get alternative suggestions: same category but with lower price or negative price change
  const suggestions = allProduceItems
    .filter(prod =>
      prod.category === item.category &&
      prod.code !== item.code &&
      (prod.avg_price < item.avg_price || prod.change_percent < 0)
    )
    .sort((a, b) => a.avg_price - b.avg_price)
    .slice(0, 3);

  const changeColorClass = item.change_percent < 0 ? 'text-green-600' : 'text-red-600';
  const changeIcon = item.change_percent < 0 ? '↓' : '↑';

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent data-testid="detail-drawer" className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl">{item.name}</DialogTitle>
          <DialogDescription className="text-base">
            {item.category} • {item.market}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Price Info */}
          <div className="bg-gray-50 p-4 rounded-lg">
            <h3 className="font-semibold text-lg mb-3">價格資訊</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-sm text-gray-600">平均價格</p>
                <p className="text-2xl font-bold">${item.avg_price.toFixed(1)}</p>
                <p className="text-xs text-gray-500">/{item.unit}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">價格變動</p>
                <p className={`text-2xl font-bold ${changeColorClass}`}>
                  {changeIcon} {Math.abs(item.change_percent).toFixed(1)}%
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600">上價</p>
                <p className="text-lg font-semibold">${item.upper_price.toFixed(1)}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">下價</p>
                <p className="text-lg font-semibold">${item.lower_price.toFixed(1)}</p>
              </div>
            </div>
          </div>

          {/* Details */}
          <div className="space-y-2">
            <h3 className="font-semibold text-lg">詳細資訊</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <p><span className="text-gray-600">品項代碼:</span> {item.code}</p>
              <p><span className="text-gray-600">分類:</span> {item.category}</p>
              <p><span className="text-gray-600">產地:</span> {item.origin || '未提供'}</p>
              <p><span className="text-gray-600">交易量:</span> {item.trade_volume.toLocaleString()} {item.unit}</p>
            </div>
          </div>

          {/* Alternative Suggestions */}
          {suggestions.length > 0 && (
            <div className="border-t pt-4">
              <h3 className="font-semibold text-lg mb-3">💡 價格更優的同類選擇</h3>
              <div className="space-y-2">
                {suggestions.map((sugg) => (
                  <div key={`${sugg.code}-${sugg.market}`} className="bg-green-50 p-3 rounded-lg">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-semibold">{sugg.name}</p>
                        <p className="text-xs text-gray-600">{sugg.market} • {sugg.origin || '未提供'}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-green-600">${sugg.avg_price.toFixed(1)}</p>
                        <p className="text-xs text-gray-600">
                          省 ${(item.avg_price - sugg.avg_price).toFixed(1)}
                        </p>
                      </div>
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
