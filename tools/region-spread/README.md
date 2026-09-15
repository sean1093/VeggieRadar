# tools/region-spread

Measures whether the regional board of
[#23](https://github.com/sean1093/VeggieRadar/issues/23) would show a real
price difference, and whether it would have the sample to say so. One-off,
read-only: it writes a report and touches nothing the app serves.

## Why it exists

Issue #23 proposes a 北/中/南/東 switcher on the strength of one estimate —
「高麗菜 at Taipei No. 1 and at the Kaohsiung market can differ by 30%」 — that
nobody has measured. Three things have to be true before the feature is worth
building, and the repository has never checked any of them:

1. **The difference is big enough to show.** If regions typically sit 4% apart,
   the switcher moves a small number by a rounding error.
2. **Each region clears the gate.** `MIN_TRADE_VOLUME` (200 kg) is a nationwide
   threshold; splitting four ways divides a crop's volume without lowering it.
   A region that qualifies on a third of days is a tab that is usually empty.
3. **A regional change-percent is a price move.** Wholesale markets rest on
   fixed weekdays — the crop crawler builds its whole sampling stride around
   that (`tools/catalog/src/build-catalog.ts`). Nationwide, one closed market is
   diluted by twelve others; inside one region it can be half the sample, so a
   day-over-day move can be the market mix changing rather than the price.

The run also produces the thing #23's design section marks "to be verified
against the actual `MarketCode`": the list of markets MOA actually publishes,
with the region each was assigned.

## Run it

```bash
cd tools/region-spread
npm ci
npm test              # the statistics, on hand-checked series — no network
npm run typecheck     # erasable-syntax check; the runtime only strips types
npm run measure       # the last 30 days, every board item
```

```bash
npm run measure -- --days 60          # a longer window
npm run measure -- --root 甘藍 --root 蕹菜   # a few roots, for a quick look
```

A 30-day run over ~100 roots is roughly 300 MOA requests at 4 concurrent with a
pause between batches — a few minutes. Every response is cached under `.cache/`
(gitignored, derived, re-downloadable), so **fixing the region table and
re-running costs nothing**. That matters, because the first run's job is to
tell you what the table is missing.

Output lands in `report/<from>_<to>.md` (paste-ready for the issue) and
`report/<from>_<to>.json` (the same numbers, for further slicing). Both are
gitignored: commit the one run you are drawing a conclusion from, into the
issue, not into the tree.

## What it reports

| Section | Answers |
| --- | --- |
| 1. 市場對照表 | Every market seen, its codes, and the region `src/regions.ts` gave it. **Fails loudly while any market is unmapped** — unmapped volume still counts nationwide, so the regional numbers would describe a board nobody would ship. |
| 2. 區域價差 | Per crop and per day, the gap between the dearest and cheapest qualifying region as a share of today's nationwide price. Median and p90. |
| 3. 樣本量 | Per region, the share of trading days it clears `MIN_TRADE_VOLUME`, and how many crops could support 0–4 regions. |
| 4. 分區漲跌 | `changeGap` (how far the regional move lands from the nationwide one over the same date pair) and `mixChurn` (how often the contributing markets changed between consecutive qualifying days). |
| 5. 每個品項 | Coverage and signed deviation from nationwide, per crop per region. |

## The region table is a hypothesis

`src/regions.ts` is seeded from #23's own table plus the two market names the
committed fixture proves (`台北一`, `台北二`). `regionOf` never guesses: no
prefix search, no fuzzy match. Anything it has not been told lands in `其他`,
is reported with its volume share, and keeps the run's own mapping check red.

A near-miss that quietly landed a market in the wrong region would be
indistinguishable from a real regional price difference — the exact error this
measurement exists to rule out.

## What it does not decide

Nothing here says whether to build the feature. Two inputs are outside its
reach:

- **Where users actually are.** #23's first acceptance criterion is the GA4 city
  distribution; if one region dominates, the smaller change ("default region =
  the user's region") wins regardless of what the spread turns out to be.
- **The retail band.** The markup is fitted on Taichung and Taipei retail
  (`tools/calibrate`), so the headline retail number stays nationwide whatever
  this run shows. A regional switcher changes the wholesale line only.

## How it stays honest

Every number the board would publish comes from the board's own code. The tool
loads `backend/*.gs` into one scope the way `tools/calibrate` and
`frontend/backendCode.test.ts` do, and uses `BOARD_ITEMS`, `selectRows`,
`weightedAverage`, `MIN_TRADE_VOLUME` and `CATTY_PER_KG` directly; every GAS
service is stubbed to throw. It groups and compares, and re-implements none of
the arithmetic — a measurement of a board that does not exist would be worse
than no measurement.
