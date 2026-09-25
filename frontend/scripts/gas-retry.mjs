/**
 * The one retry policy for every scheduled request this repo makes to Apps
 * Script: the production probe's two GAS checks (`prod-probe.mjs`) and the
 * deploy step's mirror fetches (`fetch-retry.mjs`, from `deploy-pages.yml`).
 *
 * Apps Script answers a cold start on `/exec` with a platform 404 HTML page —
 * in practice after queueing the request for ~15 s — and an account near its
 * quota queues requests until the deadline expires. Neither means the backend
 * is broken. The app already knows this: `fetchBoard` makes three attempts
 * for exactly this reason (`src/services/api.ts`). The probe made one, so a
 * single cold start opened a prod-alert issue that the next run closed again
 * (#48, #49); the deploy's fetch made one, so a day of cold starts froze the
 * board mirror at 04:22 while GAS itself stayed healthy (#53). Either is how
 * an alert channel teaches its reader to ignore the one alert that matters.
 *
 * Only *reachability* is retried. A 200 whose body fails the board contract —
 * stale, too few items, schema drift, a platform HTML page served with a 200 —
 * is a real finding that a second attempt would hide behind a minute of
 * waiting. The split is the whole point of this module: a request that never
 * reached `doGet` says nothing about the backend, while anything `doGet`
 * actually answered is evidence.
 */

/**
 * True when the response means "ask again", not "the backend is wrong".
 *
 * `doGet` always answers JSON, even for its own exceptions, so a 404 or a 5xx
 * is proof the request never got there: a cold start, or Google having a
 * moment. A timeout, DNS or TLS failure never got an answer at all.
 */
export function isTransient(res) {
  if (!res) return false;
  if (res.error) return true;
  return res.status === 404 || res.status >= 500;
}

/**
 * The same question for a static host (GitHub Pages), where a 404 is the
 * definitive "nothing published here" rather than a cold start: only a 5xx or
 * a request that never got an answer is worth asking again.
 */
export function isTransientStatic(res) {
  if (!res) return false;
  if (res.error) return true;
  return res.status >= 500;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Calls `get(url)` until it answers something other than a transient failure.
 *
 * Returns the last response either way, so a caller that runs out of attempts
 * still reports the real symptom rather than a generic "gave up". The added
 * `attempts` count lets the alert say how hard it tried, which is the
 * difference between "Apps Script blinked" and "the backend is gone".
 *
 * `sleep` is injected so the tests do not spend the backoff; `transient`
 * decides what is worth asking again (`isTransient` for Apps Script,
 * `isTransientStatic` for a static host). Transport concerns such as the
 * deadline belong to `get` — wrap it.
 */
export async function withRetry(get, url, { attempts = 3, backoffMs = 2_000, sleep = wait, transient = isTransient } = {}) {
  // `elapsedMs` spans every attempt and every wait between them, where `ms`
  // is only the last request. A caller reporting "answered in 0.8 s after 4
  // attempts" from `ms` alone would describe 75 s of waiting as under a
  // second, and a caller comparing it with a browser's deadline would be
  // comparing the wrong number.
  const started = Date.now();
  let res;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    res = await get(url);
    if (!transient(res)) return { ...res, attempts: attempt, elapsedMs: Date.now() - started };
    // Linear, not exponential: a cold start takes seconds, and the probe runs
    // on a schedule where a bounded wait is cheaper than a false alarm.
    if (attempt < attempts) await sleep(backoffMs * attempt);
  }
  return { ...res, attempts, elapsedMs: Date.now() - started };
}

/** `" after 3 attempts"`, or nothing when the first attempt settled it. */
export function attemptSuffix(res) {
  return res && res.attempts > 1 ? ` after ${res.attempts} attempts` : '';
}

/**
 * One request with a deadline, shaped for `withRetry`. Never throws: a dead
 * host is data, and `isTransient` is what decides whether to ask again. The
 * default deadline matches the deploy step's old `curl --max-time 30`; Apps
 * Script over quota *queues* requests instead of failing fast, and a queued
 * request must not hold a scheduled job open.
 */
export async function get(url, { timeoutMs = 30_000, userAgent = 'VeggieRadar-fetch-retry' } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': userAgent },
    });
    // `ms` is how long the answer took. A caller that gives the backend a
    // longer deadline than the browser does needs it: an answer this probe
    // waited 25 s for is one every visitor already timed out on.
    return { status: response.status, body: await response.text(), ms: Date.now() - started };
  } catch (error) {
    // A deadline surfaces as TimeoutError, DNS/TLS failures as TypeError.
    return {
      status: 0,
      body: '',
      ms: Date.now() - started,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

/**
 * What a final response means to a caller that wanted a file. A 200 is the
 * only success — whatever its body, which is the validator's question, not a
 * fetch's. Anything else names itself with the attempt count, so a deploy
 * step summary reads the way the probe's alert does.
 */
export function outcome(res) {
  if (!res) return { ok: false, reason: 'no response' };
  if (res.error) return { ok: false, reason: `request failed${attemptSuffix(res)}: ${res.error}` };
  if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}${attemptSuffix(res)}` };
  // A 200 with nothing in it is not a file anyone can publish or validate; it
  // is named here so the one verdict the step reads is never contradicted by
  // a shell-side size check.
  if (!res.body) return { ok: false, reason: `HTTP 200 with an empty body${attemptSuffix(res)}` };
  return { ok: true, reason: `ok${attemptSuffix(res)}` };
}
