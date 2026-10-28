/** Ten minutes: a crawl from Taiwan has no six-minute limit to fit in, but one MOA stalls should still end. */
export const CRAWL_BUDGET_MS = 10 * 60 * 1000;

/**
 * The day's crawl as the backend would make it, as the body `?action=push`
 * takes (`backend/Push.gs`): the backend's own `crawlDays`, with a budget of
 * its own (`CRAWL_BUDGET_MS`), so a crawl cut short fails here with the
 * backend's reason.
 * @param {ReturnType<import('./backend.mjs').loadBackend>} api
 * @returns {{payload: Object|null, error: string|null, summary: {latest: string|null, prev: string|null, roots: number, unanswered: {latest: string[], prev: string[]}}}}
 */
export function crawl(api) {
  const days = api.withCrawlBudget(api.crawlDays, CRAWL_BUDGET_MS);
  const roots = api.boardRoots().length;
  if (days.error) {
    return { payload: null, error: days.error, summary: { latest: null, prev: null, roots, unanswered: { latest: [], prev: [] } } };
  }
  const latest = days.dates.latest;
  const prev = days.dates.prev;
  return {
    payload: { dates: { latest, prev }, today: days.today, prev: days.prev },
    error: null,
    summary: {
      latest,
      prev,
      roots,
      unanswered: days.unanswered,
    },
  };
}
