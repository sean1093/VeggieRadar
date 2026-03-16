import React from 'react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';

interface ProduceTrendChartProps {
  trend?: number[];
}

const ProduceTrendChart: React.FC<ProduceTrendChartProps> = ({ trend }) => {
  if (!trend || trend.length === 0) {
    return <div data-testid="produce-trend-chart" className="text-center text-gray-500 text-sm">無趨勢資料</div>;
  }

  // Recharts expects an array of objects for data
  const chartData = trend.map((price, index) => ({
    name: `Day ${index + 1}`, // Placeholder for actual dates if available
    price: price,
  }));

  return (
    <div data-testid="produce-trend-chart" className="w-full h-16">
      <ResponsiveContainer width="100%" height="100%" className="recharts-responsive-container">
        <LineChart data={chartData}>
          <Line
            type="monotone"
            dataKey="price"
            stroke="#8884d8" // A neutral color, can be dynamic later
            strokeWidth={2}
            dot={false} // Minimalist: no dots on data points
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default ProduceTrendChart;
