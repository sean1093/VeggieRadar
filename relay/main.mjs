// The relay's entry point (`npm start`): listens, and nothing else, so tests
// can import `serve` without starting a server however the file is reached.
import { createServer } from 'node:http';
import { serve } from './server.mjs';

const port = Number(process.env.PORT) || 8080;
createServer((req, res) => void serve(req, res)).listen(port, () => console.log(`moa-relay listening on ${port}`));
