/**
 * Query normalisation, shared with the backend.
 *
 * A search box accepts anything, and the two ends used to disagree about what
 * a query meant: the client only did `name.includes(q)`, so 「onion」 and
 * 「高丽菜」 missed on the board and cost a live MOA query for an item that was
 * on screen all along. Both ends now run these same steps against the same
 * table (`shared/search-aliases.json`) and the same fixture
 * (`shared/normalize-query.fixture.json`).
 *
 * The steps, in order:
 *   1. **fold** — trim, full-width → half-width, collapse inner runs of
 *      whitespace (aliases like `napa cabbage` contain single spaces),
 *      lower-case.
 *   2. **de-simplify** — a ~60 character produce map, not OpenCC. Every key
 *      exists only in simplified Chinese, so a query that was already
 *      Traditional cannot be rewritten into something else.
 *   3. **de-suffix** — 「菜價」「多少錢」…, longest match first, repeated until
 *      stable, and never down to an empty string: 「菜價」 alone is the query.
 *   4. **alias** — one lookup on the settled form, so the result is the MOA
 *      root name wherever the table knows one. The order matters: stripping
 *      before the lookup is what lets 「荷蘭豆多少錢」 reach 豌豆.
 *
 * Alias resolution comes last rather than mid-pipeline (as the issue sketched
 * it) so that the output is always the most MOA-resolvable form of the query —
 * which is what the backend's catalogue gate and live query need. It also
 * makes the result independent of the script the shopper typed in: 「高丽菜」
 * and 「高麗菜」 both normalise to 甘藍.
 */
import table from '../../../shared/search-aliases.json';

/** Query → MOA root. Keys are pre-folded, so a lookup needs no further work. */
const ALIASES: Record<string, string> = table.aliases;
const SIMPLIFIED: Record<string, string> = table.simplified;
const SUFFIXES: readonly string[] = table.suffixes;

/** Full-width ASCII (`Ａ`-`ｚ`, digits) and the ideographic space. */
const FULL_WIDTH = /[\uFF01-\uFF5E\u3000]/g;

function fold(raw: string): string {
  return raw
    .replace(FULL_WIDTH, (ch) => (ch === '\u3000' ? ' ' : String.fromCharCode(ch.charCodeAt(0) - 0xfee0)))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Drops question suffixes from the end. Longest first, because 「多少錢」 must
 * not be shortened to 「多少」 plus a stray 錢, and repeatedly, because
 * 「洋蔥價格多少」 carries two.
 */
function stripSuffixes(query: string): string {
  let out = query;
  for (;;) {
    let longest = '';
    for (const suffix of SUFFIXES) {
      // `out.length > suffix.length` is the "never strip to empty" rule: a
      // query that IS a suffix is all the shopper gave us.
      if (suffix.length > longest.length && out.length > suffix.length && out.endsWith(suffix)) {
        longest = suffix;
      }
    }
    if (!longest) return out;
    out = out.slice(0, out.length - longest.length).trim();
  }
}

/**
 * Every form of a query worth matching: what the shopper typed (folded) and,
 * when the alias table knows one, the MOA root it means. Both are kept because
 * they match different things — 「蔥」 finds 洋蔥 on the board by name, while
 * its alias 青蔥 finds the items rooted there.
 */
export function searchTerms(raw: string): string[] {
  const typed = stripSuffixes([...fold(raw)].map((ch) => SIMPLIFIED[ch] ?? ch).join(''));
  // `hasOwn`, not `??`: 「constructor」 is a typeable string, and a plain
  // lookup would answer it with Object's constructor.
  const canonical = Object.hasOwn(ALIASES, typed) ? ALIASES[typed] : typed;
  return typed === canonical ? [typed] : [typed, canonical];
}

/** The single canonical form of a query: the last, most resolvable term. */
export function normalizeQuery(raw: string): string {
  const terms = searchTerms(raw);
  return terms[terms.length - 1];
}
