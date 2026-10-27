import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { handle } from './handler.mjs';

const port = Number(process.env.PORT) || 8080;

/**
 * One request's answer, whatever goes wrong producing or sending it: an
 * exception here would otherwise end the process, and with it every request
 * in flight on the instance — a crawl's whole batch.
 */
export async function serve(req, res, handleImpl = handle) {
  let out;
  try {
    out = await handleImpl({ method: req.method, url: req.url, headers: req.headers }, { key: process.env.RELAY_KEY });
  } catch (err) {
    out = { status: 500, contentType: 'text/plain; charset=utf-8', body: 'relay error' };
    console.error('relay:', err);
  }
  try {
    res.writeHead(out.status, { 'content-type': out.contentType, 'cache-control': 'no-store' });
    res.end(out.body);
  } catch (err) {
    console.error('relay: answer not sent:', err); // e.g. a header value Node refuses
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('upstream: unusable answer');
    } else {
      res.destroy();
    }
  }
}

// Listening only when run (`npm start`), not when a test imports `serve`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer((req, res) => void serve(req, res)).listen(port, () => console.log(`moa-relay listening on ${port}`));
}
