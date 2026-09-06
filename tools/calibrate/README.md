# tools/calibrate

Fits the retail-markup tables the app's headline prices are built from, and
generates `backend/RetailCalibration.gs`.

Taiwan publishes no retail price API for produce (README §4 has the survey), so
the band is computed: `retail ≈ wholesale + markup(crop)`. This tool measures
`markup(crop)` by joining two municipal retail feeds to MOA wholesale on the
same dates, applies the listing rules README §4 states in prose, and writes the
tables plus a report.

## Run it

```bash
cd tools/calibrate
npm ci
npm test          # the rules, on committed fixtures — no network
npm run calibrate # fetch → join → fit → evaluate → emit
npm run typecheck # erasable-syntax check; the runtime only strips types
```

Three dev dependencies, no build step: `vitest` runs the tests, and
`typescript` + `@types/node` exist for `npm run typecheck` alone. That check is
not cosmetic — `tsconfig.json` sets `erasableSyntaxOnly`, which is what keeps an
enum or a parameter property out of source that Node executes by *erasing*
annotations rather than compiling them.

`npm run calibrate` writes two things:

- `backend/RetailCalibration.gs` — the three tables, nothing else.
- `report/<YYYY-MM>.md` — coverage, held-out error, and every crop's
  observation count, tier, and old-vs-new value.

Add `--keep-shipped` to write the values that are live today instead of this
run's fit. The report still carries the full comparison, so a refit becomes a
proposal a human accepts rather than a change a cron job lands:

```bash
npm run calibrate -- --keep-shipped
```

Every download is cached under `.cache/` (gitignored, derived, re-downloadable),
so iterating on the fit is offline and instant. Delete it to force a refetch.
A cold run makes ~3,700 MOA requests at 4 concurrent with a pause between
batches — budget a couple of hours.

## What it reads

| Source | Granularity | Used for |
| --- | --- | --- |
| [臺中市公有零售市場每日蔬果價格表](https://data.gov.tw/dataset/84539) | daily, 14 markets, 42 produce items | tier 1 |
| [臺北市公有零售市場行情](https://data.taipei/dataset/detail?id=54d9d492-1e2e-40d1-ae7b-fbce6f271bf1) | monthly, 122 items, 18 snapshots | tier 2 |
| [MOA `AgriProductsTransType`](https://data.moa.gov.tw/api/v1/AgriProductsTransType/) | daily, per market | the wholesale side of both |

Both retail feeds quote `元/台斤`, the unit the app displays, so no conversion
happens on the retail side. The wholesale side goes through the backend's own
`CATTY_PER_KG`.

Neither retail feed uses MOA root names, so `src/sources/taichung.ts` and
`src/sources/taipei.ts` each carry a hand-checked column/item → root dictionary
alongside the list of series they knowingly ignore (fish, meat, eggs, and a few
products that share a name with a card but are a different good — dried
shiitake against the board's wet 濕香菇, for instance). A series in neither list
is reported as `UNMAPPED` in the run log and the report instead of being
dropped silently.

`data.taipei` has no metadata endpoint that names a resource's month, so the
month → resource-id map is scraped off the rendered dataset page and checked
against `fixtures/taipei-resources.json`, which is also the test fixture and the
fallback if the page changes shape.

## Why it loads the backend instead of reimplementing it

`selectRows`, `rowRoot`, `tradedRows`, `weightedAverage` and `BOARD_ITEMS` only
exist as `backend/*.gs`. `src/backend.ts` concatenates those files and evaluates
them with stubbed GAS services — the same technique
`frontend/backendCode.test.ts` uses — so the wholesale price this tool fits
against is produced by the code that serves the board. A second implementation
would drift, and a calibration that drifts from the runtime is worse than none.

The stubs throw. Nothing here may reach a GAS service.

## How the numbers map to README §4

| README §4 | here |
| --- | --- |
| `retail ≈ wholesale + markup(crop)` | `join.ts` — one observation is `retail − wholesale`, both 元/台斤 |
| tier 1, fitted midpoint | `fit.ts` `tier1Midpoint` — median of the crop's daily markups |
| tier 2, fitted `[p10, median, p90]` | `fit.ts` `tier2Band` |
| tier 3, hand-tuned per category | `src/category-bands.ts` — an input, never fitted, copied out verbatim |
| "fewer than 8 observations → not listed" | `fit.ts` `hasEnoughObservations` |
| "must be strictly tighter than the category band" | `fit.ts` `isNarrowerThanCategory` |
| "Taipei-derived crops only" | `fit.ts` `tierFor` |
| the accuracy table | `evaluate.ts` → the report's *Held-out accuracy* |
| "holdout must be after the fit window" | `fit.ts` `splitByTime` |
| the outward NT$5 rounding | NOT here — it stays in `retailBand`; rounding twice would compound to NT$10 |

Each rule in `fit.ts` has a test for the normal case, its boundary, and the case
it must refuse (`test/fit.test.ts`). They are one-line predicates on purpose:
every one of them was a measurement that contradicted the obvious guess, and
prose in a README cannot stop the next refit from quietly relaxing one.

## Layout

```
src/backend.ts          loads backend/*.gs; exports the row helpers and constants
src/http.ts             cached fetch, 4 concurrent, one retry on an empty body
src/sources/taichung.ts the daily feed + its column → root dictionary
src/sources/taipei.ts   the monthly feed, its month scrape and item → root dictionary
src/sources/moa.ts      request planning, the 1,000-row cap, daily wholesale
src/join.ts             (date, root) alignment for both granularities
src/fit.ts              the listing rules and the fitted numbers
src/evaluate.ts         the 80/20 time split and the three-rule accuracy table
src/category-bands.ts   the tier-3 table (input)
src/emit.ts             renders the .gs file and the report
src/cli.ts              the pipeline
fixtures/               small samples of all three feeds; the tests never fetch
report/                 one committed report per refit
```

## Scheduled refits

`.github/workflows/recalibrate.yml` runs this on the 1st of each month and, if
the generated file or the report moved, opens a pull request labelled
`data-quality`. It never auto-merges: the PR body carries the coverage/error
table and the ten largest changes so a maintainer can decide whether the refit
is an improvement or just a different answer. A failed source fetch fails the
job and opens nothing.
