/**
 * The MOA relay's one rule, apart from the HTTP server so it can be tested.
 *
 * data.moa.gov.tw refuses connections from outside Taiwan, Apps Script's
 * included (#103). This runs in Taiwan (Cloud Run, asia-east1) and forwards
 * the backend's queries to that one endpoint — nothing else, so it is no open
 * proxy — for a caller holding the key.
 */
import { timingSafeEqual } from 'node:crypto';

export const MOA_ENDPOINT = 'https://data.moa.gov.tw/api/v1/AgriProductsTransType/';

/** The query parameters the backend sends (`cropUrl`), and MOA's few others. */
export const ALLOWED_PARAMS = new Set(['CropName', 'CropCode', 'MarketName', 'MarketCode', 'Start_time', 'End_time', 'TcType', 'Page']);

/** Under Apps Script's own fetch timeout, so the caller hears why. */
export const UPSTREAM_TIMEOUT_MS = 50_000;

/**
 * The body of the relay's own refusal, so the backend can tell it from a 401
 * MOA itself sent, which passes through like any other answer.
 */
export const REFUSED_BODY = 'moa-relay: unauthorized';

/**
 * Every answer the relay makes itself starts so — a refusal, a bad request,
 * an unconfigured key — so the backend can tell the relay's word from MOA's,
 * which passes through untouched.
 */
export const OWN_PREFIX = 'moa-relay: ';

const text = (status, body) => ({ status, contentType: 'text/plain; charset=utf-8', body: body.startsWith(OWN_PREFIX) ? body : OWN_PREFIX + body });

function sameKey(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {{method: string, url: string, headers: Record<string, string|undefined>}} req
 *   `url` as Node's server gives it: path and query.
 * @param {{key: string|undefined, fetchImpl?: typeof fetch, timeoutMs?: number}} opts
 * @returns {Promise<{status: number, contentType: string, body: string}>}
 */
export async function handle(req, { key, fetchImpl = fetch, timeoutMs = UPSTREAM_TIMEOUT_MS }) {
  if (!key) return text(500, 'relay not configured: set RELAY_KEY');
  if (req.method !== 'GET') return text(405, 'GET only');
  let url;
  try {
    url = new URL(req.url, 'http://relay');
  } catch {
    return text(400, 'bad request target'); // e.g. `GET http://[` — never a crash
  }
  // `/`, or a prefix a tunnel mounts it under (`/moa/`): the backend always
  // asks for the URL it was given plus `/?…`.
  if (!url.pathname.endsWith('/')) return text(404, 'not found');
  if (!sameKey(req.headers['x-relay-key'], key)) return text(401, REFUSED_BODY);

  const query = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    if (!ALLOWED_PARAMS.has(name)) return text(400, `parameter not allowed: ${name}`);
    query.append(name, value);
  }
  if (!query.has('Start_time')) return text(400, 'Start_time is required');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetchImpl(`${MOA_ENDPOINT}?${query}`, { signal: controller.signal });
    return {
      status: upstream.status,
      contentType: upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      body: await upstream.text(),
    };
  } catch (err) {
    // The backend reads anything but MOA's own answer as "not answered", and
    // retries or gives up within its budget, as it would with MOA itself.
    return text(502, `upstream: ${err && err.name === 'AbortError' ? 'timeout' : String(err && err.message || err)}`);
  } finally {
    clearTimeout(timer);
  }
}
