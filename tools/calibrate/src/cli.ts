/**
 * `npm run calibrate` — fetch, join, fit, evaluate, emit.
 *
 * Run with `--keep-shipped` to write the tables that are live today instead of
 * this run's fit; the report still carries the full old-vs-new comparison, so
 * the refit is a proposal a human accepts in the pull request rather than a
 * change that lands because a cron job woke up.
 *
 * Every download is cached under `.cache/`, so a second run is offline and
 * instant. Deleting that directory forces a full refetch.
 */
import { loadBackend } from './backend.ts';
import { stats } from './http.ts';
import { buildObservations } from './join.ts';
import { fitCrops } from './fit.ts';
import { evaluateHoldout } from './evaluate.ts';
import { emit, shippedTables } from './emit.ts';

const keepShipped = process.argv.includes('--keep-shipped');
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
const log = (line: string) => console.log(`[${elapsed()}] ${line}`);

// Read the live tables BEFORE anything writes over them: they are the "old"
// column of the report and the payload of --keep-shipped.
const shipped = shippedTables();
log(`shipped: ${Object.keys(shipped.markupRoot).length} tier-1 crops, ${Object.keys(shipped.bandRoot).length} tier-2 crops`);

const join = await buildObservations(log);
if (!join.observations.length) throw new Error('no paired observations: a source fetch must have failed');

const fits = fitCrops(join.observations);
const holdout = evaluateHoldout(join.observations);
const listed = fits.filter((f) => f.listed);
log(`fit: ${fits.length} crops with observations, ${listed.filter((f) => f.tier === 'tier1').length} tier-1, ` +
  `${listed.filter((f) => f.tier === 'tier2').length} tier-2`);
for (const score of holdout.scores) {
  log(`holdout: ${score.rule} — coverage ${(score.coverage * 100).toFixed(1)}%, ` +
    `median abs. error ${(score.medianAbsError * 100).toFixed(1)}% (${score.covered}/${score.evaluated})`);
}

const generatedOn = new Date().toISOString().slice(0, 10);
const result = emit(fits, holdout, join, shipped, { keepShipped, generatedOn, dataThrough: join.dataThrough });

log(`tier-1 reproduction: median |Δ| NT$${result.reproduction.tier1.medianAbsDelta} over ` +
  `${result.reproduction.tier1.common} crops; off by >NT$5: ${result.reproduction.tier1.offBy5.join(', ') || 'none'}`);
log(`tier-2 reproduction: ${result.reproduction.tier2.within2}/${result.reproduction.tier2.common} within NT$2, ` +
  `median |Δ| NT$${result.reproduction.tier2.medianAbsDelta} — adoption gate ${result.reproduction.gate ? 'PASS' : 'FAIL'}`);
log(`wrote ${result.gsPath} (${keepShipped ? 'shipped values kept' : 'fitted values'})`);
log(`wrote ${result.reportPath}`);
log(`moa/http: ${stats.requests} requests, ${stats.cacheHits} cache hits, ${stats.retries} retries`);

// The workflow reads the month back out of the generated header; print it too
// so an operator running this by hand knows which report to look at.
console.log(`data_through=${join.dataThrough}`);
console.log(`board_items_unlisted=${loadBackend().BOARD_ITEMS.filter((d) => !listed.some((f) => f.root === d.official)).length}`);
