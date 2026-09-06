/**
 * Type definitions for VeggieRadar produce data.
 * These match the GAS board/search API response format.
 *
 * The payload shapes are inferred from the zod schemas in `board.schema.ts`
 * rather than written twice: a hand-written interface beside a validator is a
 * pair that drifts, and the drift is invisible until the UI renders
 * `undefined`. Field-by-field documentation lives with the schema.
 */
import type * as z from 'zod/mini';
import type {
  BoardResponseSchema,
  ProduceItemSchema,
  ProduceVarietySchema,
  SearchResponseSchema,
} from './board.schema';

export type ProduceVariety = z.infer<typeof ProduceVarietySchema>;
export type ProduceItem = z.infer<typeof ProduceItemSchema>;
export type BoardResponse = z.infer<typeof BoardResponseSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

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
