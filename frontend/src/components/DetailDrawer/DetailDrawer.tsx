import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getAlternativeSuggestions } from '@/lib/utils/produce-suggestions'; // Import the helper

interface ProduceItemDetail {
  code: string;
  name: string;
  avg_price: number;
  change_percent: number;
  trend: number[];
  category: string;
  description: string;
  origin: string;
  unit: string;
}

interface DetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  item: ProduceItemDetail;
  allProduceItems: ProduceItemDetail[]; // New prop: all produce items for suggestions
}

const DetailDrawer: React.FC<DetailDrawerProps> = ({ isOpen, onClose, item, allProduceItems }) => {
  const suggestions = getAlternativeSuggestions(item, allProduceItems, 10); // Use a 10% threshold

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent data-testid="detail-drawer">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>
            {item.description}
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <p><strong>品項代碼:</strong> {item.code}</p>
          <p><strong>分類:</strong> {item.category}</p>
          <p><strong>均價:</strong> ${item.avg_price.toFixed(1)} / {item.unit}</p>
          <p><strong>漲跌幅:</strong> {item.change_percent.toFixed(1)}%</p>
          <p><strong>產地:</strong> {item.origin}</p>
          {/* Future: Add more detailed trend chart or AI insights here */}
        </div>

        {suggestions.length > 0 && (
          <div className="mt-4 border-t pt-4">
            <h4 className="font-semibold text-md mb-2">建議替代品項 (價格較低):</h4>
            <ul className="list-disc pl-5">
              {suggestions.map(sugg => (
                <li key={sugg.code} className="text-sm text-gray-700">
                  {sugg.name} - 均價: ${sugg.avg_price.toFixed(1)} ({sugg.change_percent.toFixed(1)}%)
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default DetailDrawer;
