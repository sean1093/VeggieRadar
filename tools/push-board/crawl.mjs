/** Ten minutes: a crawl from Taiwan has no six-minute limit to fit in, but one MOA stalls should still end. */
export const CRAWL_BUDGET_MS = 10 * 60 * 1000;

/**
 * The day's crawl as the backend would make it, as the body `?action=push`
 * takes (`backend/Push.gs`): the backend's own `crawlDays`, with a budget of
 * its own (`CRAWL_BUDGET_MS`), so a crawl cut short fails here with the
 * backend's reason.
 * @param {ReturnType<import('./backend.mjs').loadBackend>} api
 * @returns {{payload: Object|null, error: string|null, roots?: number, unanswered?: {latest: string[], prev: string[]}}}
 *   `roots` asked, and per day those MOA did not answer even on retry.
 */
export function crawl(api) {
  const days = api.withCrawlBudget(api.crawlDays, CRAWL_BUDGET_MS);
  if (days.error) return { payload: null, error: days.error };
  return {
    payload: { dates: days.dates, today: days.today, prev: days.prev },
    error: null,
    roots: api.boardRoots().length,
    unanswered: days.unanswered,
  };
}
