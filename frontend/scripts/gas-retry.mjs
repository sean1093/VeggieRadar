/**
 * Retry policy for the two Apps Script reachability checks in `prod-probe.mjs`.
 *
 * Apps Script answers a cold start on `/exec` with a platform 404 HTML page,
 * and an account near its quota *queues* requests until the deadline expires.
 * Neither means the backend is broken. The frontend already knows this: the
 * app's own `fetchBoard` makes three attempts for exactly this reason
 * (`src/services/api.ts`). The probe made one, so a single cold start opened a
 * prod-alert issue that the next run closed again — twice in two days, with an
 * email each time, which is precisely how an alert channel teaches its reader
 * to ignore the one alert that matters.
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

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Calls `get(url)` until it answers something other than a transient failure.
 *
 * Returns the last response either way, so a caller that runs out of attempts
 * still reports the real symptom rather than a generic "gave up". The added
 * `attempts` count lets the alert say how hard it tried, which is the
 * difference between "Apps Script blinked" and "the backend is gone".
 *
 * `sleep` is injected so the tests do not spend the backoff.
 */
export async function withRetry(get, url, { attempts = 3, backoffMs = 2_000, sleep = wait, timeoutMs } = {}) {
  let res;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    res = await get(url, timeoutMs === undefined ? {} : { timeoutMs });
    if (!isTransient(res)) return { ...res, attempts: attempt };
    // Linear, not exponential: a cold start takes seconds, and the probe runs
    // on a schedule where a bounded wait is cheaper than a false alarm.
    if (attempt < attempts) await sleep(backoffMs * attempt);
  }
  return { ...res, attempts };
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
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': userAgent },
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    // A deadline surfaces as TimeoutError, DNS/TLS failures as TypeError.
    return { status: 0, body: '', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
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
  return { ok: true, reason: `ok${attemptSuffix(res)}` };
}
