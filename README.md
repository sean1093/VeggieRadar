# VeggieRadar 🥬

Today's Taiwan wholesale vegetable & fruit prices, at a glance — plus an
estimated traditional-market retail band so you can sanity-check a stall's price
while standing in front of it. Open the app and immediately see a calm,
MUJI-inspired board of the produce people buy most — green when cheaper, clay
when pricier, priced per catty (台斤).

Three questions the board answers without typing: what does this cost today, is
that cheap *for this crop* (against its own recent norm), and which variety am I
actually being quoted when one crop trades at two very different prices.

- **Audience:** shoppers at traditional markets and home cooks, primarily on phones.
- **Experience:** board-first and mobile-first. No typing required — the common
  produce board loads instantly; search is secondary.
- **Zero-cost stack:** GitHub Pages frontend + Google Apps Script backend, sourced
  from the Taiwan Ministry of Agriculture (MOA) open data. No paid services.

> Note on language: the **UI is in Traditional Chinese** (its audience); **code,
> comments, and this documentation are in English**.

---

## 1. Design principles

- **Board-first, no typing.** The home screen lists ~100 defined items as large,
  calm rows — scan and go. Out-of-season crops return no data and drop out
  automatically, so a typical day shows ~90.
- **Per-catty pricing.** Primary price is `元/台斤` (the market convention;
  1 catty = 600 g). The MOA source is `元/公斤`, converted on the client (×0.6).
- **Lead with the price you pay; keep the fact underneath.** The headline number
  is the estimated traditional-market price (`約 44 元/台斤`) — that is what a
  shopper transacts at. The measured wholesale closing average and the reference
  band sit under it (`市場 35–55・批發 14.6`), and the drawer shows the markup
  the estimate adds. The estimate is never presented as a quoted price — see §4.
  Comparisons ranked for the shopper (「同類更划算的選擇」) use the same market
  basis, because a crop that is cheaper at auction can be dearer at the stall.
- **The change badge is wholesale.** `↓ 7.0%` tracks the wholesale average, the
  only measured series, and is labelled `批發較昨日` in the drawer. The band is
  rounded to NT$5, so it would read as frozen against small real moves.
- **Colour as meaning.** Sage `↓ 便宜了` (cheaper), clay `↑ 變貴了` (pricier),
  grey `→ 持平` (flat), compared with the previous trading day. Arrows + text back
  up the colour so it never relies on colour alone.
- **Honest freshness.** A caption shows the data date and that it is the wholesale
  closing average — wholesale prices publish after market close, so the latest day
  with real trades is shown.
- **"Cheaper than yesterday" and "cheap for this crop" are different questions.**
  `↓ 7.0%` compares with the previous trading day. The sage badge
  「比近月便宜 23%」 compares today's wholesale price with the median of that
  crop's own last 28 trading days, and 「划算優先」 sorts the board by it so the
  day's real bargains sit on top. Only the discount side gets a badge — the
  change column already covers the pricier side. See §5.
- **A blended average can match no stall.** When varieties inside one crop
  diverge (綠竹筍 at 2.5× 麻竹筍), the drawer decomposes the wholesale number
  per variety instead of pretending the average is a price. See §5.
- **Degrade honestly, never blankly.** The last good board is kept in
  localStorage: when the backend is unreachable the app serves those prices with
  「目前連不上伺服器」 plus a retry, because stale prices beat a blank page in
  front of a stall. A busy backend during search says 「服務忙碌中」 — never
  「查無此品項」, which would be a lie about the produce rather than about us.
- **MUJI aesthetic.** Paper background, ink text, hairline dividers, generous
  whitespace, restrained type. No loud colour, no heavy shadows.

---

## 2. Architecture

```
MOA open-data API ──▶ GAS refresh (4-hourly trigger) ──▶ Frontend (GitHub Pages)
  (single-date and       board   → CacheService + chunked     paints the cached
   range queries)                  ScriptProperties           board first, then
                         history → chunked ScriptProperties   revalidates
                                   (28 trading days → baseline)
```

- **Data source:** Taiwan MOA "Agricultural Products Wholesale Market Transactions"
  open data, no API key. `https://data.moa.gov.tw/api/v1/AgriProductsTransType/`
  (ROC-calendar dates, e.g. `115.08.26`; prices in `元/公斤`).
- **Backend (`backend/Code.gs`):**
  - `refreshBoardCache()` — run by a 4-hourly time-driven trigger; crawls the
    board items with `UrlFetchApp.fetchAll` (concurrent, batched at 13), stores
    the board in `CacheService` plus durable `ScriptProperties`, and appends the
    day's price to the per-item history behind the baseline (§5) — no extra MOA
    requests for it.
  - `doGet` (default) — serves the stored board instantly. **It never crawls
    synchronously** (a cold crawl exceeds the Web App response window and 404s).
    A board past `BOARD_MAX_AGE_MS` (6 h) is still served, but the request also
    queues a background rebuild, so a dead trigger self-heals instead of
    freezing the app on an old date. The threshold deliberately sits **above**
    the 4 h cadence plus the crawl: when the two were equal, a healthy board
    reported itself stale in the minutes before every scheduled run.
  - `doGet?action=search&query=<name>` — filters the board, falling back to a live
    query. Accepts Chinese and common English/colloquial terms via an alias table.
    The trading-date probe is cached for an hour, so a burst of misses no longer
    re-probes up to 16 dates each.
  - `doGet?action=getTrend&cropName=<name>&days=7` — **one** MOA range query
    (`days` clamped to 14), cached per crop per day and shared by every visitor,
    so drawer traffic stops scaling with users.
  - `doGet?action=warm` — queues a rebuild and returns immediately (`force=1`
    jumps the once-per-15-minutes lock). The crawl takes minutes, so it runs in a
    one-off trigger rather than on the request.
  - `doGet?action=backfill` — one-time seeding of the price history via range
    queries (`force=1` jumps a one-hour lock); also a one-off trigger, same
    reason.
  - `doGet?action=diag` — board freshness, installed triggers, the last refresh
    outcome, history coverage and alert state, so a stalled pipeline is
    diagnosable without the GAS console.
  - `doGet?action=alerttest` — sends one probe mail (rate-limited to one per
    hour) so the alerting channel can be verified without waiting for an
    outage; it never touches incident state.
  - Prices are volume-weighted averages across markets; items below 200 kg traded
    are filtered; the latest day with real trades is found automatically.
- **Frontend (`frontend/`):** React + Vite + TypeScript + Tailwind + shadcn/ui.
  Paints the cached board immediately and revalidates in the background, so a
  revisit renders in ~250 ms instead of waiting out the ~2 s GAS round trip.
  Every request carries a deadline (board 12 s, search 15 s, trend 8 s) because
  an over-quota Apps Script *queues* requests rather than failing fast, and a
  queued request would otherwise hold the loading skeleton for a minute. With
  `VITE_API_BASE_URL` unset it uses a bundled sample board and runs fully offline.
  **recharts is code-split**: it was roughly half the initial JS while serving
  one element inside the detail drawer, so the board — which most visits never
  leave — no longer pays for it (initial JS 560 → 274 kB, gzip 174 → 88 kB).
  The drawer warms the chunk on open, in parallel with the trend request, so
  the split costs no perceived latency.

### Two MOA quirks the backend has to defend against

Both caused wrong numbers on the live board before being fixed; `frontend/backendCode.test.ts`
locks them down.

1. **`CropName` matches as a substring of `<root>-<variety>`, not as a prefix.**
   Querying `蔥` also returns `洋蔥-本產` and `大蒜-蔥蒜`; `蘿蔔` also returns
   `胡蘿蔔-清洗`; `胡瓜` also returns `花胡瓜` (小黃瓜); `薑` also returns
   `薑荷花` (an ornamental flower). Every board item therefore declares the exact
   `official` root plus an optional `variety` / `excludes`, and rows are filtered
   locally by `selectRows`. Several everyday names are *not* the MOA root name —
   地瓜葉 = `甘薯葉`, 山藥 = `薯蕷`, 蒲瓜 = `扁蒲`, 佛手瓜 = `隼人瓜`,
   香瓜 = `甜瓜`, 木耳 = `濕木耳`, 金針菇 = `金絲菇`, 檸檬 = `雜柑-*檸檬*`.
2. **Closed markets return placeholder rows.** On a holiday — and for *today*
   before the closing prices publish — MOA returns rows with `CropName: "休市"`
   and zeroed price/quantity. Counting those as "this date has data" makes the
   build pick a date on which every item aggregates to nothing, so the board
   silently stops updating. `isTradingDate()` therefore requires real traded
   volume (`PROBE_MIN_VOLUME`), not a non-empty response.

Two further robustness measures: `fetchRootRows()` retries roots that came back
empty once, because a throttled 13-request batch used to drop a whole slice of
the board (including 高麗菜) without any error; and `writeChunkedProp()` splits
the ~34 KB board — and the price history — across numbered `ScriptProperties`
chunks, since a single property value is capped at 9 KB.

### GAS quotas are the real scaling limit

Two Apps Script limits bite long before anything else: **30 simultaneous
executions** per account and the daily `UrlFetchApp` budget. The board is a
cache read, so it was never the risk — the per-user actions were:

| Path | Before | Now |
| --- | --- | --- |
| Trend (one drawer open) | 7 sequential fetches + 480 ms of sleeps, 5–10 s holding an execution slot | 1 range query, then a shared cache: ~1 crawl per crop per hour for *all* users (1.3 s warm) |
| Search miss | up to 16 probe fetches plus the queries | probe cached 1 h → 7.8 s warm instead of ~31 s |
| Board | served from cache | unchanged, plus the client-side localStorage fallback |

History writes (`updateHistory`, `backfillHistory`) run inside a `LockService`
critical section: the 4-hourly refresh and a queued backfill genuinely can
overlap, and a read-modify-write race would silently drop observations. The
backfill crawls every window *before* taking the lock, so the critical section
lasts milliseconds.

### Alerting: a broken pipeline has to reach a human

`?action=diag` only helps someone who thinks to look. Two failures are
emailed to the maintainer instead, each once per 24 h incident window:

| Signal | Trigger | Why it needs its own detector |
| --- | --- | --- |
| **Failure streak** | 3 consecutive refreshes that yield no board | One failure is routine (MOA throttles a batch) and self-heals; alerting on it would train the recipient to ignore the mail |
| **Silence** | Served board older than 12 h | A deleted or broken trigger produces *no* failures to count. Nothing is running to notice, so the serving path raises this one |

A recovering refresh closes the incident with one 「已恢復正常」 mail, so an
alert always has a matching all-clear — and the mail is sent **before** the
state is cleared, because clearing first would close the incident even when the
send failed and strand the reader on a "still broken" impression.

Every one of those decisions is a read-modify-write on shared state, so they
all run inside one script-lock section (`withAlertLock`). Without it, Apps
Script's 30 simultaneous executions could turn a single incident into 30 mails
against a ~100/day quota. The lock uses `tryLock`, not `waitLock`: losing the
race means another execution is already deciding, which is the desired outcome.
History writes use `waitLock` instead — there a skipped turn would lose an
observation.

Alerting swallows every error by design: it sits on both the refresh and the
serving path, and no mail-quota, properties or lock failure may take the board
down with it. `diag` reports `alert.failure_streak` / `alert.incident_open` /
`alert.last_sent` — never the address, since `diag` is public. The
`?action=alerttest` limiter is a durable timestamp rather than a cache key,
since cache eviction would otherwise re-open a public, unauthenticated endpoint
immediately.

`MailApp` needs the `script.send_mail` scope, now declared explicitly in
`appsscript.json`. Changing scopes requires the deploying owner to re-consent,
so verify a canary deployment before redeploying the pinned production one.

### Trading date vs. refresh time

`date` / `roc_date` is the **trading date of the prices**. It legitimately stands
still over weekends, holidays and typhoon closures, when MOA publishes nothing but
`休市` placeholder rows — 2026-08-27 and 2026-08-28 were two such days island-wide.
`generated_at` is **when the backend last crawled**, and that must keep moving.

Reporting only the trading date is what made a normal market closure look like a
broken app: the UI showed a date frozen two days back with no way to tell whether
the markets were shut or the pipeline had died. The board therefore carries both,
plus `stale`, and the frontend (`src/lib/utils/freshness.ts`) turns the pair into
one of "今日行情尚未公布", "批發市場休市中" or "資料更新中".

---

## 3. API

### Board (default)
```
GET {WEB_APP_URL}/exec
```
```json
{
  "type": "board",
  "date": "2026-09-02",
  "roc_date": "115.09.02",
  "prev_date": "115.09.01",
  "generated_at": "2026-09-02T16:05:08.087Z",
  "age_ms": 84210,
  "stale": false,
  "count": 94,
  "items": [
    {
      "code": "LA1",
      "name": "高麗菜",
      "official_name": "甘藍",
      "category": "葉菜類",
      "avg_price": 22.1,
      "catty_price": 13.3,
      "retail_low": 35,
      "retail_price": 42,
      "retail_high": 55,
      "retail_estimated": true,
      "change_percent": -13.5,
      "baseline_price": 16.3,
      "vs_baseline_percent": -18.5,
      "varieties": [
        { "name": "改良種", "catty_price": 12, "retail_price": 41, "share_percent": 62 },
        { "name": "初秋", "catty_price": 18.9, "retail_price": 48, "share_percent": 19 }
      ],
      "trade_volume": 570700,
      "unit": "公斤",
      "markets_count": 13
    }
  ],
  "cached": true
}
```
`avg_price` is `元/公斤`. `catty_price`, the three `retail_*` fields,
`baseline_price` and both `varieties[].catty_price` / `varieties[].retail_price`
are `元/台斤`.
`retail_estimated` is always `true` — see §4.

**Every derived field is optional and clients must treat it as such**: an older
deploy's cached board lacks them, and the backend omits them whenever the data
does not justify publishing.

| Field(s) | Omitted when |
| --- | --- |
| `retail_*` | the cached board predates the retail band |
| `baseline_price`, `vs_baseline_percent` | fewer than 10 in-horizon observations for that crop (§5) |
| `varieties` | fewer than 2 varieties clear the share and volume thresholds (§5) |

`date` is the trading date; `generated_at` is when the backend crawled. See
"Trading date vs. refresh time" in §2 — clients must not present the trading date
alone as "last updated". `stale: true` means the board is past its max age and a
rebuild has been queued (`refresh_queued`); the stale board is still served.

### Search
```
GET {WEB_APP_URL}/exec?action=search&query=高麗菜
```
Same `items` shape with `type: "search"`; no match returns `{ "error": "查無此品項" }`.
A board hit answers with **zero** MOA traffic; only a genuine miss falls through
to a live query.

### Trend
```
GET {WEB_APP_URL}/exec?action=getTrend&cropName=甘藍&days=7
→ { "cropName": "甘藍", "days": 7, "trend": [23.1, 24.0, null, 24.4, ...] }
```
Oldest → newest, `元/公斤`; `null` = no market that day (holiday, or today before
the closing prices publish). `days` is clamped to **14**: one MOA response caps
near 1000 rows, and 14 days of a high-volume crop stays under it. The payload is
cached for an hour per crop and shared across visitors, so repeat opens cost no
MOA traffic.

### Refresh, backfill & diagnostics
```
GET {WEB_APP_URL}/exec?action=warm[&force=1]
→ { "type": "warm", "queued": true, "message": "已排入背景更新，約一分鐘後生效", "board": { ... } }

GET {WEB_APP_URL}/exec?action=backfill[&force=1]
→ { "type": "backfill", "queued": true, "message": "已排入背景回填，約數分鐘後生效",
     "history": { "items": 97, "min_days": 1, "max_days": 24 } }

GET {WEB_APP_URL}/exec?action=diag
→ { "type": "diag", "board": { "generated_at": ..., "stale": false },
     "triggers": ["refreshBoardCache"], "last_refresh_ok": "...", "last_refresh_fail": null,
     "history": { "items": 97, "min_days": 1, "max_days": 24 },
     "alert": { "failure_streak": 0, "incident_open": false, "last_sent": null } }

GET {WEB_APP_URL}/exec?action=alerttest
→ { "type": "alerttest", "sent": true, "message": "已寄出測試信" }
```
`warm` and `backfill` both queue their crawl in a one-off trigger and answer at
once — the crawls take minutes and would blow the Web App response window.
`backfill` is idempotent per trading date, so re-running only fills gaps. `diag`
is how you tell "markets closed" from "refresh pipeline dead" without the GAS
console, and how you confirm history coverage after a backfill.

---

## 4. The retail reference band

**There is no retail price API to consume.** Verified against the MOA OpenAPI
spec (60 endpoints), the full MOA dataset catalogue (1,711 datasets) and
data.gov.tw (53,103 datasets): Taiwan publishes vegetables and fruit at
*farmgate* and *wholesale* only. The single government retail price series is
`CH11 畜產都市零售價格` — livestock. `amis.afa.gov.tw` is wholesale-only and has
no JSON API.

So the band is **computed**, and labelled as an estimate everywhere it appears.

### Model

```
retail_元/台斤  ≈  wholesale_元/台斤  +  markup(crop)
```

Additive, not multiplicative, because a stall's margin is driven by handling,
shrinkage and rent amortised per unit sold rather than by a percentage. The same
~NT$28/catty markup explains a NT$9 cabbage retailing at NT$35 (a 3.9× ratio) and
a NT$41 pear retailing at NT$67 (1.6×). Fitting a multiplier instead roughly
doubles the error; fitting a free-slope line overfits and produces a *negative*
slope for 瓜果類, which would predict cheaper retail as wholesale rises.

`RETAIL_MARKUP_ROOT` holds 30 per-crop markups (each with ≥5 paired
observations); anything else falls back to `RETAIL_MARKUP_CATEGORY`. The band is
`markup × 0.75 … markup × 1.35`, rounded outward to NT$5 because stalls price in
round numbers and because implying single-digit precision on an estimate would be
dishonest.

### Calibration and accuracy

Markups were fitted by joining MOA wholesale to two real municipal retail feeds
on matching dates:

| Source | Granularity | Coverage |
| --- | --- | --- |
| [臺中市公有零售市場每日蔬果價格表](https://newdatacenter.taichung.gov.tw/) | daily, 14 markets | 42 produce items, rolling 365 days |
| [臺北市公有零售市場行情](https://data.taipei/) | monthly | 122 items (fills 果菜類 / 菇類 gaps) |

Both are keyless JSON and quote `元/台斤` — the same unit the app displays, so no
`/0.6` conversion is involved on the retail side.

Held out the most recent month (dates after the fitting window) — **278 unseen
observations**:

- band coverage **80%**
- median absolute error of the midpoint **9.4%**
- median signed bias **+2.3%**

That accuracy is why the UI shows a range rather than a single number, and why
the drawer says 「非實際報價」. The two feeds are used *offline* to derive the
constants; the runtime has no dependency on them, so the retail band adds no new
network call and no new failure mode.

---

## 5. Relative-price signals

An absolute price answers "what does this cost". Shoppers also ask "is that
cheap?" and "cheap for *which* variety?" — neither of which the blended daily
average can answer.

### Cheap against its own norm (`vs_baseline_percent`)

Comparing crops with each other is meaningless (香菇 at NT$60/catty is not
"expensive" beside 高麗菜 at NT$15). Each crop is therefore compared with
itself: the **median of its own last 28 trading days**, wholesale basis.

- **Median, not mean** — a typhoon spike must not redefine "normal".
- **Today is excluded** from its own baseline: a spike day cannot vouch for itself.
- **A 45-calendar-day horizon** sits on top of the 28-day window, so a crop
  returning from months out of season is never judged against last season.
- **Fewer than 10 in-horizon observations → nothing is published**, and the UI
  drops the badge rather than ranking on thin data.

Why 28 trading days and not two weeks or a whole season: a 14-day window gets
swallowed by the very disruption it should flag — a typhoon rally runs 2–6 weeks
(roughly the leafy-green replant cycle), so the baseline climbs with the price
and then reports "cheaper" at NT$60 when normal is NT$30. A 90-day window
answers a question nobody asks at a market: it drags a whole season's structural
shift into today's comparison, so an entire early winter reads as "cheap". The
28-day window also captures the in-season signal the user actually wanted —
entering peak supply *is* the moment a crop drops below its own recent norm.

**The history costs no extra MOA traffic.** Each refresh already computes every
item's price, so it appends `(trading date, 元/公斤)` to a chunked-
`ScriptProperties` store. Trimming rides on every write (window, horizon, and
items no longer on the board), so the store is bounded by construction at
~17 KB against the 500 KB properties quota — there is deliberately no separate
cleanup job that could silently die. `?action=backfill` seeds ~20 trading days
once via range queries; the dailies top it up from there.

### Which variety is it (`varieties`)

MOA rows are `<root>-<variety>`, and the spread inside one crop can dwarf the
day's move. On 2026-09-02: 綠竹筍 at NT$57.1/catty against 麻竹筍 at NT$23.2
(2.5×), 愛文 mango at NT$58.5 against 凱特 at NT$23.8 (2.5×). The board's
blended 竹筍 number matched neither stall.

The drawer decomposes it, published only when a breakdown adds something:
**≥2 varieties, each holding ≥10% of the item's traded volume** and clearing the
absolute volume floor, volume-sorted (so the market mainstream reads first) and
capped at 4 rows; unlabelled rows group as 一般. Shares are computed against the
item's *total* volume, so folded-away varieties leave an honest gap — and the
drawer discloses that remainder whenever it is nonzero, not merely when it is
large. A "roughly complete" threshold used to hide gaps of 1–9%, which let the
weighted-average sentence below describe rows that quietly omitted volume.

Each row carries **both** bases, exactly like the card: the estimated market
price leads and the measured wholesale price supports it. Publishing wholesale
alone made the section unusable — a shopper is quoted retail, so a
wholesale-only row cannot be compared with anything at the stall, and it
silently disagreed with the card's retail headline.

Applying the root markup to a variety works precisely *because* the markup is
additive and constant per crop:

```
retail_variety = wholesale_variety + markup(root)
retail_blend   = wholesale_blend   + markup(root) = Σ(share × retail_variety)
```

The markup's error is identical for both, while the variety row uses a more
precise wholesale input — so for the variety in front of the shopper it is
*more* accurate than the headline. The identity also makes the card's headline
the volume-weighted average of the rows, which `mockBoard.test.ts` holds the
bundled demo to. Verified in the UI: a 竹筍 card reading 約 61 against rows of
54 / 51 / 85 at shares 41 / 34 / 25 — a weighted average of 60.7.

Two limits are stated in the drawer rather than papered over:

- **Approximate, not exact.** Each row price and each share is rounded
  independently of the headline, so the drawer says 約等於, not 等於.
- **Root-level uncertainty.** §4's markups are fitted on paired *root-crop*
  observations. 綠竹筍 and 麻竹筍 may genuinely carry different stall margins;
  nothing measures that. A variety row therefore inherits the root's error band
  rather than earning its own, and the drawer says so — showing a single 約 N
  per row without that sentence would claim precision the model lacks.

This also exposes a pre-existing subtlety honestly: a seasonal rotation in the
variety mix moves the blended average even when no single variety moved. The
breakdown lets a shopper see through such a day.

---

## 6. Local development

### Frontend
```bash
cd frontend
npm install
npm run dev      # http://localhost:5173/VeggieRadar/
```
With no `VITE_API_BASE_URL`, the app uses `src/services/mockBoard.ts` (fully
interactive offline). To use the real backend, set it in `frontend/.env`:
```
VITE_API_BASE_URL=<your GAS Web App /exec URL>
```

```bash
npm run build          # tsc typecheck + vite build
npm run test:run       # vitest once — includes backendCode.test.ts, which loads
                       # ../backend/Code.gs with stubbed GAS services
npm test               # vitest in watch mode
npm run test:coverage  # v8 coverage report
```
163 tests at ~97% statement / ~90% branch coverage. `vitest.config.ts` pins
`TZ=Asia/Taipei`: the freshness assertions are written in the audience's local
time and would otherwise pass only on machines in that zone (a UTC CI runner
caught exactly that).

### Backend (Google Apps Script)
Code lives in `backend/Code.gs`, deployed with `clasp` (`.clasp.json` sets
`rootDir` to `backend/`).
1. `clasp push`, then deploy as a **Web App** (execute as: me; access: anyone).
   `clasp push` only moves HEAD — the `/exec` URL serves a pinned version, so
   redeploy the same deployment to publish code:
   `clasp deploy -i <deploymentId> -d "<description>"`.
2. Run `installDailyTrigger()` once in the editor — it installs the refresh
   trigger on `REFRESH_INTERVAL_HOURS` and warms the board so the first visitor
   never hits a cold crawl. Confirm with `?action=diag`: `triggers` must list
   `refreshBoardCache`. Running it also grants the mail scope the alerting
   needs; `?action=alerttest` confirms a mail actually arrives.
3. Hit `?action=backfill` once to seed the baseline history (the crawl takes a
   few minutes), then confirm `diag.history.items` is non-zero. Until it is, the
   board simply ships without baseline fields and the UI hides the badge and the
   划算優先 sort.
4. Put the Web App `/exec` URL in `frontend/.env` as `VITE_API_BASE_URL`.

> The MOA API needs no key.

---

## 7. Deployment

- **CI** via `.github/workflows/ci.yml`: every pull request runs the suite plus
  a typecheck/build. Pushes are gated inside the deploy workflows themselves
  (both run the suite before publishing), so a red test blocks either surface
  without duplicating the run.
- **Frontend → GitHub Pages** via `.github/workflows/deploy-pages.yml`: pushing to
  the default branch runs the tests, builds `frontend/` and publishes to Pages. In
  the repo, set **Settings → Pages → Source: GitHub Actions**. Live at
  `https://<user>.github.io/VeggieRadar/` (`vite.config.ts` `base` is `/VeggieRadar/`).
- **Backend → Apps Script** via `.github/workflows/deploy-gas.yml` (optional):
  set repo secrets `GCP_SA_KEY` (or `CLASP_TOKEN`); otherwise deploy manually with
  `clasp`. See `clasp_instructions.md`. The workflow runs the backend regression
  tests, pushes, **redeploys the pinned `DEPLOYMENT_ID`** — without that step
  `/exec` keeps serving old code — and then queues a board refresh via
  `?action=warm&force=1`.

> Both deploy workflows need Node 22+: the suite uses `Promise.withResolvers`.

---

## 8. Roadmap

- Per-variety baselines. Today's baseline is blended across varieties (blend vs.
  blend is self-consistent, and the median resists mix rotation), while the
  variety breakdown is same-day only.
- A rules-based 「今日推薦」 strip on top of the board — deliberately deferred
  until the 划算優先 sort proves the demand.
- Recalibrate the retail markups periodically against the Taichung daily feed;
  the current constants were fitted on data through 2026-08.
- Per-region retail bands (the calibration feeds are Taichung + Taipei only).
- PWA install to home screen (pending a `vite-plugin-pwa` build compatible with Vite 8).
- Per-market / per-region filtering.
- Line Bot lookups (`doPost` is reserved).

## License
MIT (to be added).
