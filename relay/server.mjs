import { createServer } from 'node:http';
import { handle } from './handler.mjs';

const port = Number(process.env.PORT) || 8080;

createServer(async (req, res) => {
  const out = await handle(
    { method: req.method, url: req.url, headers: req.headers },
    { key: process.env.RELAY_KEY },
  );
  res.writeHead(out.status, { 'content-type': out.contentType, 'cache-control': 'no-store' });
  res.end(out.body);
}).listen(port, () => console.log(`moa-relay listening on ${port}`));
