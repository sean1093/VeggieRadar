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
 * Whether the published mirror alone would carry a visitor through a GAS
 * outage — which is a stricter question than "did the `mirror` check pass".
 *
 * `useBoard` serves the mirror without touching GAS only while `isFreshEnough`
 * holds, and that threshold is `BOARD_MAX_AGE_MS` (6 h), not the probe's 8 h
 * bound. Past it every visitor falls through to `fetchBoard()` — three doomed
 * attempts, then the board degrades onto that same stale mirror under
 * 「目前連不上伺服器」. Prices stay on screen, so this is still not the board
 * going dark; what changes is that every visit now pays for a dead round trip
 * and is told the service is unreachable. That is a fault worth a human, and
 * the band is reachable during exactly the outage this rule is about:
 * `deploy-pages.yml` can only republish the mirror it already has while GAS is
 * down, so the same board ages in place.
 *
 * The bar is the app's, with no safety margin added, and that is deliberate.
 * The backend crawls every 4 h, so a perfectly healthy mirror is routinely
 * 4–6 h old; a margin wide enough to matter would page for a momentary cold
 * start that happened to land late in a crawl cycle — the false alarm this
 * whole rule exists to stop. The cost is latency, not blindness: a mirror that
 * crosses 6 h between probe runs is caught by the next one, at most 6 h later,
 * and `checkMirror` pages on its own at 8 h regardless.
 *
 * The count matters for the same reason. A throttled MOA batch publishes a
 * board that is complete enough to validate and clearly short of a day's
 * produce; `checkGasBoard` is what normally catches it, and during an outage
 * that check never gets a body to measure. Holding the mirror to
 * `BOARD_HEALTHY_ITEMS` here keeps a thin board from being silently accepted
 * as proof that visitors are fine.
 */
function mirrorCarriesVisitors(checks, { maxAgeMs, healthyItems }) {
  const mirror = checks.find((check) => check.name === 'mirror');
  // `skipped` means no mirror is published at all — then GAS is the only path
  // a visitor has, and its silence is an outage, not a degradation.
  if (!mirror || mirror.status !== 'ok' || !mirror.serving) return false;
  return mirror.serving.ageMs < maxAgeMs && mirror.serving.count >= healthyItems;
}

/**
 * Downgrades unreachable-GAS failures to `degraded` while the mirror is
 * genuinely carrying visitors, and leaves every other verdict exactly as the
 * checks reported it.
 *
 * Contract failures are never softened — they are evidence the backend
 * answered and was wrong.
 */
export function applyVerdict(checks, thresholds) {
  if (!mirrorCarriesVisitors(checks, thresholds)) return checks;
  return checks.map((check) =>
    check.status === 'failed' && check.category === GAS_UNREACHABLE ? { ...check, status: DEGRADED } : check,
  );
}
