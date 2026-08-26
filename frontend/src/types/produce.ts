/**
 * Type definitions for VeggieRadar produce data.
 * These match the GAS board/search API response format.
 */

export interface ProduceItem {
  code: string;
  name: string;            // 顯示用俗名，如「高麗菜」
  official_name: string;   // 農業部官方名，如「甘藍」
  category: string;        // 葉菜類 / 根莖類 / 瓜果類 / 果菜類 / 辛香類 / 水果 / 其他
  avg_price: number;       // 元 / 公斤（全市場成交量加權平均）
  catty_price: number;     // 元 / 台斤
  change_percent: number;  // 與前一交易日相比
  trade_volume: number;    // 公斤
  unit: string;            // 公斤
  markets_count: number;   // 納入平均的市場數

  // Optional — only present in some responses / kept for the detail drawer.
  market?: string;
  origin?: string;
  upper_price?: number;
  middle_price?: number;
  lower_price?: number;
  trend?: number[];
}

export interface BoardResponse {
  type: 'board';
  date: string;          // ISO, e.g. 2026-08-26
  roc_date: string;      // 115.08.26
  prev_date: string;
  count: number;
  items: ProduceItem[];
  cached?: boolean;
}

export interface SearchResponse {
  type: 'search';
  query: string;
  date: string;
  count: number;
  items: ProduceItem[];
}

export interface ApiErrorResponse {
  type?: string;
  error: string;
  query?: string;
  message?: string;
  suggestion?: string;
  items?: ProduceItem[];
}

export type ApiResponse = BoardResponse | SearchResponse | ApiErrorResponse;

/** Type guard: response carries an error. */
export function isApiError(response: ApiResponse): response is ApiErrorResponse {
  return 'error' in response && !!(response as ApiErrorResponse).error;
}
