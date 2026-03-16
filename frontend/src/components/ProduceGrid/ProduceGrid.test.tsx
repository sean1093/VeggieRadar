import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import ProduceGrid from './ProduceGrid';

describe('ProduceGrid', () => {
  it('renders the ProduceGrid component', () => {
    render(<ProduceGrid />);
    expect(screen.getByTestId('produce-grid')).toBeInTheDocument();
  });

  it('displays a loading message when no data is provided', () => {
    render(<ProduceGrid />);
    expect(screen.getByText('載入中...')).toBeInTheDocument();
  });

  it('displays a message when no produce items are found', () => {
    render(<ProduceGrid items={[]} />);
    expect(screen.getByText('目前沒有蔬果資訊。')).toBeInTheDocument();
  });
});
