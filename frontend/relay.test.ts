/**
 * The MOA relay (`relay/handler.mjs`, #103): forwards the backend's queries
 * from Taiwan to the one MOA endpoint, for a caller holding the key — and is
 * no open proxy for anyone else.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — a plain ES module outside the app, with no types
import { handle, MOA_ENDPOINT } from '../relay/handler.mjs';

const KEY = 'k'.repeat(64);
const QUERY = '/?CropName=%E7%94%98%E8%97%8D&Start_time=115.10.26&End_time=115.10.26';

type Out = { status: number; contentType: string; body: string };

/** A fetch that records the URL it was asked for and answers like MOA. */
const moa = (status = 200, body = '{"RS":"OK","Data":[]}') => {
  const asked: string[] = [];
  const fetchImpl = async (url: string) => {
    asked.push(url);
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return { asked, fetchImpl };
};

const call = (url: string, headers: Record<string, string> = { 'x-relay-key': KEY }, method = 'GET', fetchImpl = moa().fetchImpl): Promise<Out> =>
  handle({ method, url, headers }, { key: KEY, fetchImpl });

describe('MOA relay', () => {
  it('forwards the query to the MOA endpoint and passes its answer through', async () => {
    const upstream = moa(200, '{"RS":"OK","Data":[{"CropName":"甘藍"}]}');
    const out: Out = await call(QUERY, undefined, 'GET', upstream.fetchImpl);
    expect(upstream.asked).toEqual([`${MOA_ENDPOINT}?CropName=%E7%94%98%E8%97%8D&Start_time=115.10.26&End_time=115.10.26`]);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).Data[0].CropName).toBe('甘藍');
  });

  it("passes MOA's own failure status through, so the backend reads it as unanswered", async () => {
    const out: Out = await call(QUERY, undefined, 'GET', moa(503, 'busy').fetchImpl);
    expect(out.status).toBe(503);
  });

  it('refuses a caller without the key, or with the wrong one', async () => {
    const upstream = moa();
    for (const headers of [{}, { 'x-relay-key': 'wrong' }, { 'x-relay-key': KEY + 'x' }]) {
      expect((await call(QUERY, headers, 'GET', upstream.fetchImpl)).status).toBe(401);
    }
    expect(upstream.asked).toEqual([]);
  });

  it("is no open proxy: one path, MOA's parameters only, GET only", async () => {
    const upstream = moa();
    expect((await call(`/elsewhere${QUERY.slice(1)}`, undefined, 'GET', upstream.fetchImpl)).status).toBe(404);
    expect((await call(`${QUERY}&url=https://example.com`, undefined, 'GET', upstream.fetchImpl)).status).toBe(400);
    expect((await call('/?CropName=x', undefined, 'GET', upstream.fetchImpl)).status).toBe(400); // no date
    expect((await call(QUERY, undefined, 'POST', upstream.fetchImpl)).status).toBe(405);
    expect(upstream.asked).toEqual([]);
  });

  it('refuses everything until a key is configured', async () => {
    const out: Out = await handle({ method: 'GET', url: QUERY, headers: { 'x-relay-key': '' } }, { key: undefined, fetchImpl: moa().fetchImpl });
    expect(out.status).toBe(500);
  });

  it('answers 502 when MOA does not, within its own timeout', async () => {
    const hang = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const out: Out = await handle({ method: 'GET', url: QUERY, headers: { 'x-relay-key': KEY } }, { key: KEY, fetchImpl: hang, timeoutMs: 20 });
    expect(out.status).toBe(502);
    expect(out.body).toMatch(/timeout/);
  });
});
