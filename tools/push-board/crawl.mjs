/**
 * The day's crawl as the backend would make it, as the body `?action=push`
 * takes (`backend/Push.gs`): the trading date and the one before, and every
 * board root's rows on each.
 * @param {ReturnType<import('./backend.mjs').loadBackend>} api
 * @returns {{payload: Object, summary: {latest: string|null, prev: string|null, roots: number, answered: number, unanswered: string[]}}}
 */
export function crawl(api) {
  const dates = api.resolveTradeDates(true);
  if (!dates.latest) {
    return { payload: null, summary: { latest: null, prev: null, roots: 0, answered: 0, unanswered: [] } };
  }
  const roots = api.boardRoots();
  const meta = { answered: {}, truncated: {}, unanswered: {} };
  const today = api.fetchRootRows(roots, dates.latest, undefined, meta);
  const prev = dates.prev ? api.fetchRootRows(roots, dates.prev, undefined, meta) : {};
  const unanswered = Object.keys(meta.unanswered).sort();
  return {
    payload: { dates: { latest: dates.latest, prev: dates.prev || null }, today, prev },
    summary: {
      latest: dates.latest,
      prev: dates.prev || null,
      roots: roots.length,
      answered: roots.length - unanswered.length,
      unanswered,
    },
  };
}
