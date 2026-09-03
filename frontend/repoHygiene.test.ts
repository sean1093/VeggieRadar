/**
 * Repo hygiene invariants.
 *
 * The GAS deploy workflow materialises a service-account key inside the
 * checkout (`> ./gcp-sa-key.json`). That is fine on an ephemeral CI runner and
 * a loaded gun anywhere else: one `git add -A` on a machine that ran those
 * steps commits a live credential. This test ties the ignore rules to the
 * workflow that creates the hazard, so adding a new credential-writing step
 * without ignoring its output fails here rather than in someone's git history.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(repoRoot, p), 'utf8');

/** Files a workflow redirects into the checkout, e.g. `> ./gcp-sa-key.json`. */
function workspaceWrites(yaml: string): string[] {
  return [...yaml.matchAll(/>\s*\.\/([\w.-]+)/g)].map((m) => m[1]);
}

describe('credential hygiene', () => {
  const workflows = ['.github/workflows/deploy-gas.yml', '.github/workflows/deploy-pages.yml', '.github/workflows/ci.yml'];

  it('ignores every file the workflows write into the checkout', () => {
    const ignore = read('.gitignore');
    const written = workflows.flatMap((w) => workspaceWrites(read(w)));

    expect(written).toContain('gcp-sa-key.json'); // guards the regex itself
    for (const file of written) {
      expect(ignore).toContain(file);
    }
  });

  it('tracks no file that git would consider a credential', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n');
    const suspicious = tracked.filter((f) =>
      /(^|\/)\.clasprc\.json$|gcp-sa-key|client_secret|credentials.*\.json$|\.pem$|\.p12$/.test(f),
    );
    expect(suspicious).toEqual([]);
  });

  it('keeps secrets out of the one env file that ships to browsers', () => {
    // Vite inlines every VITE_* variable into the public client bundle, so this
    // file is public by construction no matter what git does with it. Only the
    // backend endpoint belongs here.
    const env = read('frontend/.env');
    const keys = [...env.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
    expect(keys).toEqual(['VITE_API_BASE_URL']);
  });
});
