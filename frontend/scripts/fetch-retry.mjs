/**
 * `fetch-retry.mjs <url> <out> [gas|static]` — download one URL to a file on
 * the probe's retry terms, for the two fetches in `deploy-pages.yml`'s
 * mirror step.
 *
 * Both of those used to be a single `curl`. On 2026-09-13 Apps Script
 * answered every scheduled fetch of `?action=board` with its cold-start 404
 * (after queueing the request for ~15 s), so every run "succeeded" by
 * republishing the same 04:22 board until the probe paged (#53) — while the
 * probe itself rode the same 404s out, because `gas-retry.mjs` had given it
 * three attempts. The fallback fetch of the already-published mirror was one
 * attempt too, and its failure mode is worse: no mirror at all, and every
 * visitor pays a GAS execution and a cold start until the next deploy lands.
 *
 * The third argument says whose 404 this is. `gas` (default): a 404 is Apps
 * Script's cold start and is asked again. `static`: the URL is GitHub Pages,
 * where a 404 is the definitive "nothing published here" — only a 5xx or a
 * dead connection is worth a second attempt, and a summary that read
 * `HTTP 404 after 3 attempts` for it would suggest a CDN blip that never was.
 *
 * The policy and the decision both live in `gas-retry.mjs`, where the tests
 * are; this file is only the command line around them, and runs
 * unconditionally — an "am I the main module" guard broke the first time the
 * script was run through a symlink, and silently, which is the one way this
 * step must never fail.
 *
 * Exit 0: the body of a 200 is in `out`; stdout says `ok after N attempts`.
 * Exit 1: nothing written; stdout says why (`HTTP 404 after 3 attempts`,
 *         `request failed after 3 attempts: TimeoutError: …`,
 *         `HTTP 200 with an empty body`).
 * Exit 2: usage.
 */
import { writeFileSync } from 'node:fs';
import { get, isTransient, isTransientStatic, outcome, withRetry } from './gas-retry.mjs';

const [url, out, kind = 'gas'] = process.argv.slice(2);
if (!url || !out || !['gas', 'static'].includes(kind)) {
  process.stderr.write('usage: fetch-retry.mjs <url> <out> [gas|static]\n');
  process.exitCode = 2;
} else {
  // Keep this at or below the probe's TIMEOUT_MS (`prod-probe.mjs`): the probe
  // treats "the deploy can still refresh the mirror" as proof that visitors
  // are served, so a deploy that waits longer than the probe does would let a
  // queued backend look healthy to the deploy and unreachable to the probe.
  const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS) || 30_000;
  const res = await withRetry((u) => get(u, { timeoutMs, userAgent: 'VeggieRadar-deploy-mirror' }), url, {
    transient: kind === 'static' ? isTransientStatic : isTransient,
  });
  const result = outcome(res);
  if (result.ok) writeFileSync(out, res.body);
  process.stdout.write(`${result.reason}\n`);
  // Set the code rather than calling process.exit(), which can truncate a
  // piped message mid-write.
  process.exitCode = result.ok ? 0 : 1;
}
