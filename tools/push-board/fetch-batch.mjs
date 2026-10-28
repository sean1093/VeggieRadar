/**
 * GETs every URL on stdin (a JSON array) at once and prints their answers in
 * order, `[{status, body}]` — run as a child process, so the backend's
 * `UrlFetchApp.fetchAll` batch stays concurrent while it waits synchronously.
 * A request that fails or takes over a minute (Apps Script's own limit) is
 * status 0.
 */
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const answers = await Promise.all(JSON.parse(Buffer.concat(chunks).toString('utf8')).map(async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: '', error: String(err && err.cause ? err.cause : err) };
  }
}));
process.stdout.write(JSON.stringify(answers));
