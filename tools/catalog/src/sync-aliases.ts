/**
 * Generates `backend/SearchAliases.gs` from `shared/search-aliases.json`.
 *
 * The alias table used to live in `backend/Config.gs`, where the frontend could
 * not read it — so 「onion」 missed on the client and cost a live backend query
 * for an item that was on the board all along. The JSON is now the single
 * source: the frontend imports it, Apps Script gets this generated copy, and
 * `frontend/repoHygiene.test.ts` fails if the copy drifts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSearchAliases, type AliasSpec } from './render.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const spec = JSON.parse(readFileSync(resolve(REPO, 'shared/search-aliases.json'), 'utf8')) as AliasSpec;

writeFileSync(resolve(REPO, 'backend/SearchAliases.gs'), renderSearchAliases(spec));
console.log(
  `SearchAliases.gs: ${Object.keys(spec.aliases).length} aliases, ` +
    `${Object.keys(spec.simplified).length} simplified characters, ${spec.suffixes.length} suffixes`,
);
