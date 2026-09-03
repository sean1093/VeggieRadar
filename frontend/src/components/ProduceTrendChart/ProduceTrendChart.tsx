import React from 'react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';

interface ProduceTrendChartProps {
  trend?: number[];
}

const ProduceTrendChart: React.FC<ProduceTrendChartProps> = ({ trend }) => {
  if (!trend || trend.length === 0) {
    return <div data-testid="produce-trend-chart" className="text-center text-gray-500 text-sm">無趨勢資料</div>;
  }

  // The Line reads `price`; no axis is rendered, so no label field is needed.
  const chartData = trend.map((price) => ({ price }));

  return (
    <div data-testid="produce-trend-chart" className="w-full h-16">
      <ResponsiveContainer width="100%" height="100%" className="recharts-responsive-container">
        <LineChart data={chartData}>
          <Line
            type="monotone"
            dataKey="price"
            stroke="#6E7B5B" // sage; recharts' default purple is outside the palette
            strokeWidth={2}
            dot={false} // Minimalist: no dots on data points
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default ProduceTrendChart;
