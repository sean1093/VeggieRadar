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
 *
 * The same argument runs the other way, and `mirrorMerelyLate` below is where:
 * a stale mirror beside a healthy backend is the CDN fast path lost, not a
 * board lost. The two softenings each require the other path to be `ok`, so
 * they can never both apply, and a run where neither path serves always pages.
 *
 * That backstop is also the limit of what may be softened. It exists only
 * because `deploy-pages.yml` refreshes the mirror from `?action=board`, so it
 * engages when *that* endpoint is the one not answering. A quiet
 * `?action=diag` beside a healthy board is a different fault with no backstop
 * at all — `handleDiag` does real work per call while `readBoard` is a cache
 * read, so diag can fail alone — and the mirror would keep refreshing forever
 * while `gas_trigger`, `gas_incident` and `gas_history` sat at `skipped` and
 * nobody was ever told the baselines stopped publishing. So it pages.
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

/** The mirror is still publishing, but on the fallback cron rather than on the crawl. */
export const DISPATCH_FAILING = 'dispatch_failing';

/**
 * How late a mirror may be before lateness stops being the explanation.
 *
 * The worst lateness this project has produced is 15.2 h: an 11.2 h gap
 * between scheduled deploys plus a 4 h crawl on top. The margin above that is
 * one hour on purpose, because the cost of the margin is one-sided — every
 * hour inside it is an hour the CDN fast path is bypassed on every visit with
 * nobody told.
 *
 * The crawl term is the backend's 4 h cadence, deliberately, not the 8 h
 * ceiling `validate-board.mjs` will publish up to. That ceiling is a reject
 * bound, not an expectation: a board approaching it means the backend already
 * missed a crawl, and a mirror inheriting that is not a deploy running late
 * — it is two things behind at once, which is worth saying out loud.
 *
 * The probe samples on its own schedule, so this is a bound on the *verdict*,
 * not on the alert. That schedule is measured, not assumed — a 6.6 h median
 * and an 8.8 h worst against a cron asking for 6 h, the same gap between ask
 * and reality this project keeps rediscovering — so a mirror that freezes can
 * go unreported until about 25 h, against 17 h before any softening existed. That is the price of not paging for ordinary
 * lateness, and it is only worth it while 16 h really is above ordinary — if
 * the deploy cadence changes, re-measure and move this with it.
 *
 * Past it, the mirror is not late. #53's froze on repeated failed fetches
 * while the deploys themselves kept succeeding, which no deploy gap bounds.
 */
export const MIRROR_BACKSTOP_MS = 16 * 60 * 60 * 1000;

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
 * The mirror of the rule above, for the other path.
 *
 * A stale mirror beside a healthy backend costs a visitor nothing they can
 * see: `useBoard` paints the old board, `fetchBoard` succeeds, and current
 * prices replace it. What it costs is the CDN fast path — a round trip and a
 * GAS execution on every visit instead of none. That is worth fixing and not
 * worth waking anyone, and it is the ordinary shape of this project's worst
 * measured week: scheduled deploys land a median 4.5 h apart against a cron
 * asking for 2 h, and the mirror's age is that gap plus the board's age when
 * the deploy ran (issue #66, #68).
 *
 * `staleBackstopMs` is what stops this from being a blanket excuse. Past it
 * the deploy is not running late; something stopped publishing, and no amount
 * of backend health makes that self-correcting. A mirror whose `generated_at`
 * is missing, unparsable or in the future never carries a `serving` at all
 * (`checkMirror`), so it is never softened either — those are corrupt, not
 * late.
 */
function mirrorMerelyLate(checks, { staleBackstopMs }) {
  const mirror = checks.find((check) => check.name === 'mirror');
  if (!mirror || mirror.status !== 'failed' || mirror.category !== 'mirror_stale') return false;
  if (!mirror.serving) return false;
  return mirror.serving.ageMs < staleBackstopMs;
}

/**
 * What `checkMirror` may hand `applyVerdict` about the board it fetched, or
 * null when this mirror must never be softened.
 *
 * The decision lives here rather than in the check because it is a policy
 * question, not an I/O one: `mirror_stale` is the category for schema drift
 * and for a `generated_at` that is missing or in the future as much as for a
 * board that is merely old, and only the last of those is a deploy running
 * late. Softening the others would be exactly the contract failure this module
 * says it never softens.
 *
 * `problemKind` is `boardProblem`'s verdict — null when the board is clean,
 * `'schema'` or `'stale'` otherwise. `maxSkewMs` mirrors the tolerance the
 * check itself applies, so a board it calls fresh is never left unmeasurable
 * and a concurrent backend outage still softens.
 */
export function servingFor({ ageMs, count, problemKind, maxSkewMs }) {
  if (ageMs === null || ageMs < -maxSkewMs) return null;
  if (problemKind && problemKind !== 'stale') return null;
  return { ageMs, count };
}

/**
 * The browser's own deadline for one `?action=board` attempt — `BOARD_TIMEOUT_MS`
 * in `src/services/api.ts`, pinned to it by `api.timeouts.test.ts` because the
 * probe cannot import that module without dragging the app in.
 */
export const CLIENT_BOARD_TIMEOUT_MS = 12_000;

/**
 * True when the backend answered a clean, current board *and did it the way a
 * visitor would have got it*.
 *
 * The probe is deliberately more patient than the app, in two directions, and
 * neither may be lent to this decision:
 *
 *   - It waits 30 s per attempt (`TIMEOUT_MS`) so a queued request does not
 *     read as an outage, where `fetchBoard` abandons each attempt at 12 s.
 *     Apps Script over quota queues rather than failing fast, so an answer at
 *     25 s is `ok` here and a timeout for everyone.
 *   - It retries four times over 30 s of backoff. `fetchBoard` also retries a
 *     404 — three attempts, 0.9 s then 1.8 s apart — and how long that spans
 *     depends on what it is failing against: about 5 s when the backend
 *     refuses quickly, up to ~38 s when each attempt runs to its 12 s
 *     deadline. Against a queued backend the probe's own first attempt would
 *     have burned 30 s before retrying, so a retry there means the client's
 *     three had timed out too; against a fast refusal the probe's first
 *     backoff of 5 s already outlasts the client's whole schedule. So a
 *     second attempt means the client was served only in a narrow band — a
 *     refusal that cleared between roughly 1 s and 5 s — and this errs
 *     toward paging in it, because the alternative is telling nobody while
 *     visitors sit on a stale mirror under 「目前連不上伺服器」.
 *
 * Either way every visitor is left on the old mirror under
 * 「目前連不上伺服器」, which is precisely the state a stale mirror must
 * still page for. A check that carries no timing is treated as not having
 * answered in time; only `gas_board` carries one.
 */
function servesVisitors(checks) {
  const board = checks.find((check) => check.name === 'gas_board');
  if (!board || board.status !== 'ok') return false;
  if (board.attempts !== 1) return false;
  return typeof board.answeredInMs === 'number' && board.answeredInMs <= CLIENT_BOARD_TIMEOUT_MS;
}

/**
 * Downgrades one path's failure to `degraded` while the other path is serving,
 * and leaves every other verdict exactly as the checks reported it.
 *
 * The app reads a board from two places, so an outage is one path down and a
 * fault is both. Each softening therefore requires the other path to be `ok`,
 * which makes them mutually exclusive: whatever else happens, a run in which
 * neither the mirror nor the backend is serving pages.
 *
 * Contract failures are never softened — they are evidence the backend
 * answered and was wrong.
 */
export function applyVerdict(checks, thresholds) {
  // The backend is the silent one, and the mirror is carrying visitors on the
  // app's own terms. Restricted to `gas_board` because the 8 h mirror bound is
  // what backstops it, and that bound only moves when the board endpoint is
  // what stopped answering. See the note at the top of this module.
  const boardSilent = checks.some(
    (check) => check.name === 'gas_board' && check.status === 'failed' && check.category === GAS_UNREACHABLE,
  );
  if (boardSilent && mirrorCarriesVisitors(checks, thresholds)) {
    return checks.map((check) =>
      check.status === 'failed' && check.category === GAS_UNREACHABLE ? { ...check, status: DEGRADED } : check,
    );
  }

  // The mirror is the late one, and the backend answered a clean, current
  // board — so every visitor falling through to it sees correct prices.
  if (mirrorMerelyLate(checks, thresholds) && servesVisitors(checks)) {
    return checks.map((check) => {
      if (check.name !== 'mirror') return check;
      // The excerpt goes with it. It was attached because the check failed,
      // but a mirror softened here is a *valid* board by construction — the
      // only thing wrong with it is its age — so 500 characters of correct
      // prices in the summary and in any open alert comment is pure noise.
      const { excerpt, ...rest } = check;
      return { ...rest, status: DEGRADED };
    });
  }

  return checks;
}

/**
 * What `diag.mirror_dispatch` says about the deploy the backend asks for when
 * a crawl lands (README §2).
 *
 * Never a page. A failing dispatch costs freshness, not availability: the
 * 2-hourly schedule still publishes, and the `mirror` check is what bounds how
 * old the file may get either way. But an expired PAT answers 401 on every
 * crawl and nothing else would say so from outside — which is the whole reason
 * an external probe exists.
 *
 * @param {unknown} dispatch `diag.mirror_dispatch`, or null/absent.
 * @returns {{status: string, category?: string, detail: string}}
 */
export function dispatchState(dispatch) {
  if (!dispatch || typeof dispatch !== 'object') {
    // Not a fault: with no `GH_DISPATCH_TOKEN` the backend skips the POST and
    // the schedule is the mechanism, which is how this shipped.
    return { status: 'skipped', detail: 'no dispatch recorded — GH_DISPATCH_TOKEN unset, the cron is the fallback' };
  }
  const outcome = typeof dispatch.outcome === 'string' ? dispatch.outcome : 'unknown';
  const lastOk = typeof dispatch.last_ok === 'string' ? dispatch.last_ok : null;
  const since = lastOk ? `, last accepted ${lastOk}` : ', never accepted';
  // `throttled` is a dispatch the 30-minute floor declined, which only happens
  // when one was accepted inside that window; `unknown` is the partial write
  // where the floor's clock landed and the record did not. Both mean the
  // channel works.
  if (outcome === 'dispatched' || outcome === 'throttled' || outcome === 'unknown') {
    return { status: 'ok', detail: `${outcome}${since}` };
  }
  return {
    status: DEGRADED,
    category: DISPATCH_FAILING,
    detail: `mirror_dispatch: ${outcome}${since} — the mirror is on the fallback cron;`
      + ' check the GH_DISPATCH_TOKEN script property (a fine-grained PAT with contents: write)',
  };
}
