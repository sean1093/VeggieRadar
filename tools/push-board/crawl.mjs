/**
 * The day's crawl as the backend would make it, as the body `?action=push`
 * takes (`backend/Push.gs`): the backend's own `crawlDays`, under its own
 * `CRAWL_BUDGET_MS`, so a crawl the budget or the relay cut short fails here
 * as a scheduled refresh would.
 * @param {ReturnType<import('./backend.mjs').loadBackend>} api
 * @returns {{payload: Object|null, error: string|null, summary: {latest: string|null, prev: string|null, roots: number, unanswered: {latest: string[], prev: string[]}}}}
 */
export function crawl(api) {
  const days = api.withCrawlBudget(api.crawlDays);
  const roots = api.boardRoots().length;
  if (days.error) {
    return { payload: null, error: days.error, summary: { latest: null, prev: null, roots, unanswered: { latest: [], prev: [] } } };
  }
  const latest = days.dates.latest;
  const prev = days.dates.prev || null;
  return {
    payload: { dates: { latest, prev }, today: days.today, prev: days.prev },
    error: null,
    summary: {
      latest,
      prev,
      roots,
      unanswered: { latest: [...days.unanswered.latest].sort(), prev: [...days.unanswered.prev].sort() },
    },
  };
}
