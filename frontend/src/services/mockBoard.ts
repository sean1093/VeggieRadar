/**
 * Bundled sample board for local development when no backend URL is configured.
 * Numbers are representative real values from the MOA open-data API.
 */
import type { BoardResponse } from '../types/produce';

export const MOCK_BOARD: BoardResponse = {
  type: 'board',
  date: '2026-08-26',
  roc_date: '115.08.26',
  prev_date: '115.08.25',
  cached: true,
  count: 12,
  items: [
    { code: 'LA', name: '高麗菜', official_name: '甘藍', category: '葉菜類', avg_price: 24.4, catty_price: 14.6, change_percent: -3.1, trade_volume: 416301, unit: '公斤', markets_count: 6 },
    { code: 'LB', name: '小白菜', official_name: '小白菜', category: '葉菜類', avg_price: 31.2, catty_price: 18.7, change_percent: 2.4, trade_volume: 52000, unit: '公斤', markets_count: 5 },
    { code: 'LF', name: '空心菜', official_name: '蕹菜', category: '葉菜類', avg_price: 22.8, catty_price: 13.7, change_percent: -8.5, trade_volume: 41000, unit: '公斤', markets_count: 5 },
    { code: 'RA', name: '白蘿蔔', official_name: '蘿蔔', category: '根莖類', avg_price: 22.4, catty_price: 13.4, change_percent: 5.9, trade_volume: 181600, unit: '公斤', markets_count: 6 },
    { code: 'RC', name: '馬鈴薯', official_name: '馬鈴薯', category: '根莖類', avg_price: 33.1, catty_price: 19.9, change_percent: 0.5, trade_volume: 29000, unit: '公斤', markets_count: 5 },
    { code: 'FA', name: '番茄', official_name: '番茄', category: '果菜類', avg_price: 84.0, catty_price: 50.4, change_percent: 4.2, trade_volume: 77045, unit: '公斤', markets_count: 5 },
    { code: 'FE', name: '玉米', official_name: '玉米', category: '果菜類', avg_price: 28.5, catty_price: 17.1, change_percent: -1.2, trade_volume: 63000, unit: '公斤', markets_count: 6 },
    { code: 'GA', name: '苦瓜', official_name: '苦瓜', category: '瓜果類', avg_price: 41.0, catty_price: 24.6, change_percent: -6.0, trade_volume: 38000, unit: '公斤', markets_count: 6 },
    { code: 'GC', name: '冬瓜', official_name: '冬瓜', category: '瓜果類', avg_price: 15.2, catty_price: 9.1, change_percent: -12.3, trade_volume: 54000, unit: '公斤', markets_count: 5 },
    { code: 'SA', name: '蔥', official_name: '蔥', category: '辛香類', avg_price: 58.3, catty_price: 35.0, change_percent: 25.7, trade_volume: 77610, unit: '公斤', markets_count: 6 },
    { code: 'FB', name: '香蕉', official_name: '香蕉', category: '水果', avg_price: 26.0, catty_price: 15.6, change_percent: 1.1, trade_volume: 90000, unit: '公斤', markets_count: 6 },
    { code: 'FW', name: '西瓜', official_name: '西瓜', category: '水果', avg_price: 18.7, catty_price: 11.2, change_percent: -4.4, trade_volume: 120000, unit: '公斤', markets_count: 5 },
  ],
};
