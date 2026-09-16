/**
 * Types for `probe-verdict.mjs`, which is plain ESM so the dependency-free
 * probe can run it under Node. Only `api.timeouts.test.ts` imports it from
 * TypeScript, and only for `CLIENT_BOARD_TIMEOUT_MS`; the declarations below
 * describe shapes, never values, so the one number that must not drift is
 * still compared against the real module at runtime.
 */
export interface ProbeCheck {
  name: string;
  status: 'ok' | 'failed' | 'degraded' | 'skipped';
  category?: string;
  detail?: string;
  serving?: { ageMs: number; count: number };
  answeredInMs?: number;
  attempts?: number;
}

export interface VerdictThresholds {
  maxAgeMs: number;
  healthyItems: number;
  staleBackstopMs: number;
}

export const GAS_UNREACHABLE: 'gas_unreachable';
export const DEGRADED: 'degraded';
export const CLIENT_BOARD_TIMEOUT_MS: number;

export function reachabilityCategory(res: unknown): string;
export function servingFor(input: {
  ageMs: number | null;
  count: number;
  problemKind: string | null | undefined;
  maxSkewMs: number;
}): { ageMs: number; count: number } | null;
export function applyVerdict(checks: ProbeCheck[], thresholds: VerdictThresholds): ProbeCheck[];
