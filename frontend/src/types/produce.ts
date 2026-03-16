/**
 * Type definitions for VeggieRadar produce data
 * These match the GAS API response format
 */

export interface ProduceItem {
  code: string;
  name: string;
  avg_price: number;
  change_percent: number;
  trade_volume: number;
  category: string;
  origin: string;
  unit: string;
  market: string;
  upper_price: number;
  middle_price: number;
  lower_price: number;
}

export interface ApiSuccessResponse {
  query: string;
  date: string;
  count: number;
  items: ProduceItem[];
}

export interface ApiErrorResponse {
  error: string;
  query?: string;
  message?: string;
}

export type ApiResponse = ApiSuccessResponse | ApiErrorResponse;

// Type guard to check if response is an error
export function isApiError(response: ApiResponse): response is ApiErrorResponse {
  return 'error' in response;
}
