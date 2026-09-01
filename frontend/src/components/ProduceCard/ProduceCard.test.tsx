import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ProduceCard from './ProduceCard';
import type { ProduceItem } from '../../types/produce';

const down: ProduceItem = {
  code: 'LA', name: '高麗菜', official_name: '甘藍', category: '葉菜類',
  avg_price: 24.4, catty_price: 14.6, change_percent: -3.1,
  retail_low: 35, retail_price: 44, retail_high: 55, retail_estimated: true,
  trade_volume: 416301, unit: '公斤', markets_count: 6,
};

const up: ProduceItem = {
  code: 'SE', name: '蔥', official_name: '青蔥', category: '辛香類',
  avg_price: 58.3, catty_price: 35.0, change_percent: 25.7,
  retail_low: 70, retail_price: 86, retail_high: 105, retail_estimated: true,
  trade_volume: 77610, unit: '公斤', markets_count: 6,
};

describe('ProduceCard', () => {
  it('leads with the estimated market price, not the wholesale price', () => {
    render(<ProduceCard item={down} onClick={vi.fn()} />);
    expect(screen.getByText('高麗菜')).toBeInTheDocument();
    expect(screen.getByText('約 44')).toBeInTheDocument();
    expect(screen.getByText('元/台斤')).toBeInTheDocument();
  });

  it('demotes the band and the wholesale price to one supporting line', () => {
    render(<ProduceCard item={down} onClick={vi.fn()} />);
    expect(screen.getByText('市場 35–55・批發 14.6')).toBeInTheDocument();
    expect(screen.queryByText(/元\/公斤/)).not.toBeInTheDocument();
  });

  it('derives the headline from the band when retail_price is absent', () => {
    const noMid: ProduceItem = { ...down };
    delete noMid.retail_price;
    render(<ProduceCard item={noMid} onClick={vi.fn()} />);
    expect(screen.getByText('約 45')).toBeInTheDocument();
  });

  it('announces the market price first, then the wholesale price', () => {
    render(<ProduceCard item={down} onClick={vi.fn()} />);
    expect(
      screen.getByRole('button', {
        name: '高麗菜，菜市場參考價每台斤約 44 元，區間 35 到 55 元，便宜了，批發每台斤 14.6 元',
      }),
    ).toBeInTheDocument();
  });

  it('falls back to the wholesale headline when a cached board has no retail fields', () => {
    const legacy: ProduceItem = { ...down };
    delete legacy.retail_low;
    delete legacy.retail_price;
    delete legacy.retail_high;
    render(<ProduceCard item={legacy} onClick={vi.fn()} />);
    expect(screen.getByText('14.6')).toBeInTheDocument();
    expect(screen.getByText('約 24 元/公斤')).toBeInTheDocument();
    expect(screen.queryByText(/市場/)).not.toBeInTheDocument();
  });

  it('uses sage + 便宜了 when price falls', () => {
    render(<ProduceCard item={down} onClick={vi.fn()} />);
    expect(screen.getByText(/3\.1%/).parentElement).toHaveClass('text-sage');
    expect(screen.getByText('便宜了')).toBeInTheDocument();
  });

  it('uses clay + 變貴了 when price rises', () => {
    render(<ProduceCard item={up} onClick={vi.fn()} />);
    expect(screen.getByText(/25\.7%/).parentElement).toHaveClass('text-clay');
    expect(screen.getByText('變貴了')).toBeInTheDocument();
  });

  it('calls onClick with the item when tapped', () => {
    const onClick = vi.fn();
    render(<ProduceCard item={down} onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /每台斤/ }));
    expect(onClick).toHaveBeenCalledWith(down);
  });

  it('toggles watch without opening detail (stopPropagation)', () => {
    const onClick = vi.fn();
    const onToggleWatch = vi.fn();
    render(<ProduceCard item={down} onClick={onClick} onToggleWatch={onToggleWatch} watched={false} />);
    fireEvent.click(screen.getByRole('button', { name: /關注 高麗菜/ }));
    expect(onToggleWatch).toHaveBeenCalledWith(down);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows a filled star when watched', () => {
    render(<ProduceCard item={down} onClick={vi.fn()} onToggleWatch={vi.fn()} watched />);
    expect(screen.getByRole('button', { name: /取消關注/ })).toHaveTextContent('★');
  });
});
