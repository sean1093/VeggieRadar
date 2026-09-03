/**
 * Type definitions for VeggieRadar produce data.
 * These match the GAS board/search API response format.
 */
/** 單一品種的當日行情摘要（抽屜「今日品種行情」用）。 */
export interface ProduceVariety {
  name: string;           // 品種名，如「綠竹筍」；MOA 未標品種者為「一般」
  catty_price: number;    // 批發，元/台斤（該品種成交量加權平均，實測值）
  share_percent: number;  // 佔該品項總成交量的百分比（小品種被摺疊時總和 < 100）
  // 推估菜市場價（元/台斤）＝ 該品種批發價 + 與卡片相同的攤販加成。因加成是
  // 加法常數，卡片大字恰為各品種依成交量加權的平均。舊版快取可能沒有此欄位。
  retail_price?: number;
}

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
  // 「跟平常比」基準（批發基準）：近 28 個交易日的中位數。baseline_price 為
  // 元/台斤；vs_baseline_percent 為今日批發價相對中位數的百分比（負值 = 比平常
  // 便宜）。歷史不足（新品項、剛回產季、尚未回填）時後端不送這兩個欄位。
  baseline_price?: number;
  vs_baseline_percent?: number;
  // 當日品種分解（批發）。只有 ≥2 個具意義品種（各佔量 ≥10%）時後端才送，
  // 依成交量排序、至多 4 筆。混合均價偏離個別攤位時，抽屜用它拆解。
  varieties?: ProduceVariety[];

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
