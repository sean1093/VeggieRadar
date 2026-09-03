/**
 * Repo hygiene invariants.
 *
 * The GAS deploy workflow materialises a service-account key inside the
 * checkout (`> ./gcp-sa-key.json`). That is fine on an ephemeral CI runner and
 * a loaded gun anywhere else: one `git add -A` on a machine that ran those
 * steps commits a live credential. This repo is routinely staged that way, and
 * a stray root-level vitest cache file did get committed once before the root
 * `.gitignore` existed — so these are not hypothetical.
 *
 * The assertions ask **git** whether a path is ignored rather than pattern-
 * matching `.gitignore` text. An earlier version parsed `> ./file` out of the
 * workflow YAML and substring-matched the ignore file; that silently missed
 * `>>`, `tee`, `cp`, heredocs and subdirectories, and could not see negations
 * like `!frontend/.env`. Only git implements gitignore semantics.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');

/** True when git would ignore `path`. Works for paths that do not exist. */
function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch (error) {
    // git exits 1 for "not ignored" and 128 for a real failure (not a repo,
    // bad invocation). Only the first is an answer; the second must not be
    // mistaken for one.
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) return false;
    throw error;
  }
}

describe('credential hygiene', () => {
  // Every filename the documented workflows or local steps can drop into the
  // checkout. Listing them explicitly beats deriving them: a list cannot
  // silently miss a shell construct, and a new entry is a deliberate edit.
  const mustBeIgnored = [
    'gcp-sa-key.json', // deploy-gas.yml decodes GCP_SA_KEY into this
    '.clasprc.json', // clasp's OAuth refresh token, if ever copied in
    'backend/.clasprc.json',
    'my-credentials.json',
    'client_secret_123.json',
    'server.pem',
    'key.p12',
    '.env',
    '.env.production',
    'backend/.env',
    'node_modules/anything',
    'frontend/node_modules/anything',
  ];

  it.each(mustBeIgnored)('ignores %s', (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it('keeps the one intentional env file tracked, not ignored', () => {
    // frontend/.env holds only VITE_API_BASE_URL, which Vite inlines into the
    // public bundle — public by construction, and needed for the documented
    // build. The negation in .gitignore has to survive the broad .env rules.
    expect(isIgnored('frontend/.env')).toBe(false);
  });

  it('tracks no file that looks like a credential', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n');
    const suspicious = tracked.filter((f) =>
      /(^|\/)\.clasprc\.json$|gcp-sa-key|client_secret|credentials.*\.json$|\.pem$|\.p12$/.test(f),
    );
    expect(suspicious).toEqual([]);
  });

  it('tracks no dependency or build output', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n');
    expect(tracked.filter((f) => f.includes('node_modules/') || f.startsWith('dist/'))).toEqual([]);
  });

  it('keeps secrets out of the env file that ships to browsers', () => {
    const env = readFileSync(resolve(repoRoot, 'frontend/.env'), 'utf8');
    const keys = [...env.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
    expect(keys).toEqual(['VITE_API_BASE_URL']);
  });
});
