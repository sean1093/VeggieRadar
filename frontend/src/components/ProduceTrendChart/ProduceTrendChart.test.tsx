import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import ProduceTrendChart from './ProduceTrendChart';

const mockTrendData = [10, 12, 11, 13, 15, 14, 16];
const mockEmptyTrendData: number[] = [];

describe('ProduceTrendChart', () => {
  it('renders the ProduceTrendChart component', () => {
    render(<ProduceTrendChart trend={mockTrendData} />);
    expect(screen.getByTestId('produce-trend-chart')).toBeInTheDocument();
  });

  it('renders a chart when given valid trend data', () => {
    render(<ProduceTrendChart trend={mockTrendData} />);
    // Check for a Recharts element, e.g., a div with role of graphic or a specific SVG element
    expect(screen.getByTestId('produce-trend-chart').querySelector('.recharts-responsive-container')).toBeInTheDocument();
  });

  it('displays a message when trend data is empty', () => {
    render(<ProduceTrendChart trend={mockEmptyTrendData} />);
    expect(screen.getByText('無趨勢資料')).toBeInTheDocument();
  });

  it('displays a message when trend data is undefined', () => {
    render(<ProduceTrendChart trend={undefined} />);
    expect(screen.getByText('無趨勢資料')).toBeInTheDocument();
  });
});
