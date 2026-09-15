/**
 * What the production probe's raw check results *mean* — the one rule that
 * decides whether a failure is worth waking a human for.
 *
 * The probe answers "is each endpoint healthy". That is not the same question
 * as "is VeggieRadar broken", because the app does not depend on Apps Script
 * to show a board: `useBoard` reads the static mirror published next to the
 * bundle first and only reaches GAS when that mirror is missing or stale
 * (`src/services/api.ts`). So when `?action=board` is unreachable while the
 * mirror is fresh, every visitor still gets today's prices.
 *
 * They do lose something, and it is worth naming rather than waving away: the
 * drawer's trend sparkline is empty (`fetchTrend` fails quietly by design),
 * and a search for anything the board does not carry — an out-of-season crop,
 * a typo — reaches GAS (`useSearch`) and answers 「服務忙碌中，請稍後再試」
 * instead of a result or a suggestion. Both are real; neither is the board
 * going dark, which is what this project exists to deliver and what an alert
 * at 3 a.m. should be reserved for.
 *
 * That distinction matters because Apps Script answers `/exec` with a platform
 * 404 HTML page for minutes at a time and then recovers on its own. Three
 * times now that has opened a `prod-alert` issue the next scheduled run closed
 * again (#48, #49, #61) — and an alert channel that cries wolf every few days
 * teaches its reader to ignore the one alert that matters. Retrying absorbs
 * the short windows (`gas-retry.mjs`), but no retry budget survives a window
 * measured in hours, which is what 2026-09-13 actually was (#53).
 *
 * Nothing is swept under the rug: a GAS outage long enough to matter stops the
 * crawl, the mirror it publishes stops moving, and `checkMirror`'s freshness
 * bound fails within 8 hours with a category that *does* page. This rule only
 * decides who reports the outage, not whether it is reported.
 */

import { isTransient } from './gas-retry.mjs';

/**
 * A GAS check that never got an answer — a cold-start 404, a 5xx, a timeout.
 * Kept separate from `gas_error`, which is a backend that answered *wrongly*
 * (a platform HTML page with a 200, `board.error`, schema drift) and is always
 * a page: something served that, so something is genuinely misconfigured.
 */
export const GAS_UNREACHABLE = 'gas_unreachable';

/**
 * Which kind of "no usable answer" a GAS response is.
 *
 * `isTransient` is the same predicate the retry used, and it is exactly the
 * set of symptoms proving the request never reached `doGet`: a cold-start 404,
 * a 5xx, a request that got no answer at all. Everything else `outcome()`
 * rejects came *from* the backend and is a fault that pages — a 403 on a
 * deployment whose access was narrowed to its owner, a redirect, or a 200
 * carrying an empty body. Reading `outcome().ok === false` as "unreachable"
 * would quietly downgrade those to a summary row nobody is paged for.
 */
export function reachabilityCategory(res) {
  return isTransient(res) ? GAS_UNREACHABLE : 'gas_error';
}

/** Checks with this status are shown and explained, but do not fail the run. */
export const DEGRADED = 'degraded';

/**
 * Downgrades unreachable-GAS failures to `degraded` while the mirror is
 * serving a fresh board, and leaves every other verdict exactly as the checks
 * reported it.
 *
 * The mirror must be `ok`, not merely present: `skipped` means no mirror is
 * published at all, and then GAS is the only path a visitor has, so its
 * silence is an outage and must page. Contract failures are never softened —
 * they are evidence the backend answered and was wrong.
 */
export function applyVerdict(checks) {
  const mirrorServes = checks.some((check) => check.name === 'mirror' && check.status === 'ok');
  if (!mirrorServes) return checks;
  return checks.map((check) =>
    check.status === 'failed' && check.category === GAS_UNREACHABLE ? { ...check, status: DEGRADED } : check,
  );
}
