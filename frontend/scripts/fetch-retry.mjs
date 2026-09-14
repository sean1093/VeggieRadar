/**
 * `fetch-retry.mjs <url> <out>` — download one URL to a file on the probe's
 * retry terms, for the two fetches in `deploy-pages.yml`'s mirror step.
 *
 * Both of those used to be a single `curl`. On 2026-09-13 Apps Script
 * answered every 2-hourly fetch of `?action=board` with its cold-start 404
 * (after queueing the request for ~15 s), so every run "succeeded" by
 * republishing the same 04:22 board until the probe paged (#53) — while the
 * probe itself rode the same 404s out, because `gas-retry.mjs` had given it
 * three attempts. The fallback fetch of the already-published mirror was one
 * attempt too, and its failure mode is worse: no mirror at all, and every
 * visitor for the next two hours pays a GAS execution and a cold start.
 *
 * The policy and the decision both live in `gas-retry.mjs`, where the tests
 * are; this file is only the command line around them, and runs unconditionally
 * — an "am I the main module" guard broke the first time the script was run
 * through a symlink, and silently, which is the one way this step must never
 * fail.
 *
 * Exit 0: the body of a 200 is in `out`; stdout says `ok after N attempts`.
 * Exit 1: nothing written; stdout says why (`HTTP 404 after 3 attempts`,
 *         `request failed after 3 attempts: TimeoutError: …`).
 * Exit 2: usage.
 */
import { writeFileSync } from 'node:fs';
import { get, outcome, withRetry } from './gas-retry.mjs';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  process.stderr.write('usage: fetch-retry.mjs <url> <out>\n');
  process.exitCode = 2;
} else {
  const res = await withRetry(get, url, { timeoutMs: Number(process.env.FETCH_TIMEOUT_MS) || undefined });
  const result = outcome(res);
  if (result.ok) writeFileSync(out, res.body);
  process.stdout.write(`${result.reason}\n`);
  // Set the code rather than calling process.exit(), which can truncate a
  // piped message mid-write.
  process.exitCode = result.ok ? 0 : 1;
}
