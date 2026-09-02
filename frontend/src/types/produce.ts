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

  // 傳統市場零售「參考」價（元 / 台斤）。由批發價加上校準過的攤販加成估算，
  // 不是實際報價 —— 後端以 retail_estimated 標示。舊版回應可能沒有這些欄位。
  retail_low?: number;
  retail_price?: number;
  retail_high?: number;
  retail_estimated?: boolean;

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
  date: string;          // ISO 交易日期, e.g. 2026-08-26 —— 休市時會停在最近一次交易日
  roc_date: string;      // 115.08.26
  prev_date: string;
  count: number;
  items: ProduceItem[];
  cached?: boolean;

  // 後端最後一次爬取的時間（ISO）與新鮮度旗標。交易日期停住是正常的（休市），
  // 但 generated_at 停住代表更新流程壞了 —— 兩者必須分開呈現。
  generated_at?: string;
  age_ms?: number | null;
  stale?: boolean;
  warming?: boolean;
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
  /**
   * True when the failure is transport-level (timeout, GAS over capacity,
   * non-JSON platform error page) rather than a definitive answer such as
   * 查無此品項. The UI must offer these as "busy, retry" — never as an empty
   * search result.
   */
  transient?: boolean;
}

export type ApiResponse = BoardResponse | SearchResponse | ApiErrorResponse;

/** Type guard: response carries an error. */
export function isApiError(response: ApiResponse): response is ApiErrorResponse {
  return 'error' in response && !!(response as ApiErrorResponse).error;
}
