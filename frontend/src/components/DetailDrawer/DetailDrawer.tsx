import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'; // Assuming path from shadcn/ui

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
}

const DetailDrawer: React.FC<DetailDrawerProps> = ({ isOpen, onClose, item }) => {
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
        {/* shadcn/ui DialogContent often handles its own close button if present */}
      </DialogContent>
    </Dialog>
  );
};

export default DetailDrawer;
