/**
 * What the production probe's raw check results *mean* — the one rule that
 * decides whether a failure is worth waking a human for.
 *
 * The probe answers "is each endpoint healthy". That is not the same question
 * as "is VeggieRadar broken", because the app does not depend on Apps Script
 * to show a board: `useBoard` reads the static mirror published next to the
 * bundle first and only reaches GAS when that mirror is missing or stale
 * (`src/services/api.ts`). So when `?action=board` is unreachable while the
 * mirror is fresh, every visitor still gets today's prices; what they lose is
 * the trend sparkline inside the drawer, which fails quietly by design.
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

/**
 * A GAS check that never got an answer — a cold-start 404, a 5xx, a timeout.
 * Kept separate from `gas_error`, which is a backend that answered *wrongly*
 * (a platform HTML page with a 200, `board.error`, schema drift) and is always
 * a page: something served that, so something is genuinely misconfigured.
 */
export const GAS_UNREACHABLE = 'gas_unreachable';

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
