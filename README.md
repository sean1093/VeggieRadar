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
MOA open-data API ──▶ GAS refresh (4-hourly trigger) ──▶ CacheService + chunked
  (single-date and       board   → the day's prices              ScriptProperties
   range queries)        history → 28 trading days → baseline (§5)
                                                                      │
                                                            GET /exec │
                                                                      ▼
Frontend (GitHub Pages) ◀── validate ◀── GitHub Actions (deploy-pages, cron :20 / 4 h)
  data/board.json, published inside the bundle's own artifact
        │
        ▼
Browser: localStorage (paints first) ──▶ data/board.json ──▶ GAS /exec
                                         authoritative          only when the mirror
                                         while < 6 h old        is stale or missing
```

- **Data source:** Taiwan MOA "Agricultural Products Wholesale Market Transactions"
  open data, no API key. `https://data.moa.gov.tw/api/v1/AgriProductsTransType/`
  (ROC-calendar dates, e.g. `115.08.26`; prices in `元/公斤`).
- **Backend (`backend/*.gs`):** one file per domain — `Config` (every tuneable
  constant plus the board definition), `WebApp` (the `doGet` router),
  `Board`, `Aggregate`, `History`, `Alerts`, `Moa`, `Search`. Apps Script merges
  them into one global scope, so the split is organisational, not architectural;
  no ordering config is needed or used, because no top-level initialiser here
  depends on another file — a test enforces that, so load order stays
  irrelevant rather than becoming something this repo has to pin.
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
  - `doGet?action=warm` — queues a rebuild and returns immediately. The crawl
    takes minutes, so it runs in a one-off trigger rather than on the request.
    `force=1` jumps the once-per-15-minutes lock and is honoured only with the
    operator token (below); anyone else gets the plain, lock-bounded path.
  - `doGet?action=backfill&token=…` — one-time seeding of the price history
    via range queries (`force=1` jumps a one-hour lock); also a one-off
    trigger, same reason. Operator only.
  - `doGet?action=diag` — board freshness, installed triggers, the last refresh
    outcome, history coverage and alert state, so a stalled pipeline is
    diagnosable without the GAS console. Public; the last failure's raw reason
    is reduced to a category unless the token is supplied.
  - `doGet?action=alerttest&token=…` — sends one probe mail (rate-limited to
    one per hour) so the alerting channel can be verified without waiting for
    an outage; it never touches incident state. Operator only.

  **Operator token.** The Web App is anonymous by necessity — browsers call it
  — but `warm&force`, `backfill` and `alerttest` each start a crawl or a mail on
  demand. Left open, `force=1` alone lets anyone bypass the lock and burn a few
  hundred `UrlFetchApp` calls per hit until the daily quota is gone and the
  board stops updating. Those actions therefore require `&token=` to equal the
  `ADMIN_TOKEN` script property (`isAdmin`, a constant-time comparison that
  fails closed when the property is unset). A refusal is a plain
  `{ "error": "unauthorized" }` that writes nothing, so the refusal path cannot
  itself be made expensive. Nothing a shopper uses needs the token.
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
  the split costs no perceived latency. The board schema §3 validates against
  is the only other runtime addition to that chunk, at 5.7 kB gzip — which is
  why it uses `zod/mini` rather than the classic API (295 kB / 94 kB today).

  **Installable, and openable with no signal.** `vite-plugin-pwa` (1.3.0, which
  does support Vite 8) emits a Workbox service worker plus the manifest, so the
  app installs to a home screen and launches standalone. The worker precaches
  the **shell only** — `index.html`, the hashed JS/CSS, the icons and the
  manifest, ~655 KiB — because that is what was missing offline: the last board
  was already in localStorage, but the app that renders it came off the network,
  so airplane mode meant a white page. The prices still come from localStorage;
  the worker adds nothing to that path.

  What is deliberately **not** cached is as important. The GAS `/exec` endpoint
  is `NetworkOnly`: Apps Script answers platform errors with an HTML page and
  HTTP 200, so a single bad moment stored under that URL would be served as
  "the board" until the cache was evicted — and the localStorage fallback is a
  strictly better answer anyway. `gtag` is `NetworkOnly` too (analytics must
  never be replayed from a cache, and never block a load), and the 78 kB
  social-card image is excluded, since only LINE and Facebook ever fetch it.
  Two things do get a runtime cache: the static board mirror
  (`data/board.json`, stale-while-revalidate, one entry) and Google Fonts
  (cache-first, 10 entries / a year). Navigations fall back to the precached
  shell, except under `data/` — answering a JSON request with HTML would hand
  the fetch a document to parse as a board.

  **Updates are offered, never taken.** `registerType: 'prompt'`, so a new
  deploy installs and waits; one line appears at the bottom
  (「已更新，重新整理看新版」) and the worker takes over only when the user taps
  重新整理. An automatic reload would tear the drawer out of the hands of
  someone reading a price in front of a stall, and hashed filenames plus the
  prompt bound the risk of a stale worker to "at most one version behind".
  `稍後` only hides the line; the update lands on the next natural load. The
  worker is its own file, so the initial JS carries only the registration and
  that one line (+0.8 kB gzip); `workbox-window` is a lazily imported chunk.
  While `navigator.onLine` is false the degraded board's 重試 reads 離線中 —
  the button stays tappable, since that flag describes the interface, not the
  internet.

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

### Plausibility guard

`refreshBoardCache()` used to reject exactly one thing: an *empty* board.
Everything else was stored — so a throttled crawl (40 items instead of 94) or a
MOA unit change (every price ×1.67) overwrote a good board with a wrong one, and
`updateHistory` baked the wrong numbers into the 28-day baseline on the way.
`validateBoard()` in `backend/Validate.gs` now sits between the build and the
store. Board-level rules reject the whole build; item-level rules only *mark*
the item, because withholding 93 good prices over one bad transaction is the
worse trade.

| Rule | Threshold | Why that number |
| --- | --- | --- |
| Too few items | `count < max(30, 0.6 × previous)` | A normal day carries 90–94 of the 104 defined items and seasonal drop-out is under 10 %/day, so losing 40 % is a fetch failure, not a season. The floor of 30 means "certainly broken" and sits deliberately far below the 60 the external probe alerts at — that one asks "worth a look?", this one withholds data from users |
| Mass price jump | ≥ 20 % of the common items moved beyond ×3 | A real market moves a handful of crops; a fifth of the board tripling at once is a unit or column change |
| Whole-board displacement | median common-item price ratio outside [0.5, 2] | Every price shifting by the same factor is arithmetic, not trading |
| Trading date regression | `roc_date` older than the stored board's | The date probe picked the wrong day, which makes every `change_percent` on the board wrong |
| *Item:* outlier transaction | `abs(change_percent) > 150` **and** volume below 20 % of the previous board's | A crop can double overnight; 2.5× on a tenth of the volume is one mistyped `Trans_Quantity` carrying the average. Measured against the previous *board* rather than a history median, because the history store keeps prices only |
| *Item:* grouping error | one variety above 95 % of the volume whose price differs by more than 50 % | A variety that dominant *is* the item, so a gap that wide means rows from another crop were folded in. `varietyBreakdown` cannot currently emit that shape (it needs ≥ 2 varieties, each ≥ 10 %), so this guards a future publisher change |

Every board-level rule that triggers is reported, not just the first, and a
first deploy has no stored board to compare against — then only the absolute
floor applies.

Nothing is corrected: no outlier is dropped, no price is rescaled. Choosing
which of two numbers is the real one is guessing, and a price board that guesses
has nothing left to offer. A rejected build is instead kept whole in its own
chunked property (`veggie_board_rejected_chunk_*`) as the only evidence of what
MOA answered, `veggie_last_refresh_fail` records `implausible: <reasons>`, and
the same `recordRefreshOutcome(false, …)` path feeds the existing 3-failure
alert — so the reasons arrive by mail rather than only in a log. `diag` exposes
the last verdict as `last_validation`.

Marked items stay **on** the board with `suspect: true`: an old price beats a
blank. What they lose is everything derived from comparing days — they are
excluded from the price history (a flagged observation must not bend the 28-day
median), and the frontend hides their change badge, their 「比近月便宜」 badge
and the drawer's baseline sentence, replacing the drawer's change block with
「今日成交異常，暫不顯示漲跌」.

### GAS quotas are the real scaling limit

Two Apps Script limits bite long before anything else: **30 simultaneous
executions** per account and the daily `UrlFetchApp` budget. The board was a
cache read rather than a crawl, so it never spent MOA quota — but at ~99 % of
the traffic it was almost every *execution*, which is the limit that queues
requests behind each other. The static mirror below takes that path off Apps
Script entirely; these were the per-user actions:

| Path | Before | Now |
| --- | --- | --- |
| Trend (one drawer open) | 7 sequential fetches + 480 ms of sleeps, 5–10 s holding an execution slot | 1 range query, then a shared cache: ~1 crawl per crop per hour for *all* users (1.3 s warm) |
| Search miss | up to 16 probe fetches plus the queries | probe cached 1 h → 7.8 s warm instead of ~31 s |
| Board | one execution per visit, served from cache | **no execution at all** while the static mirror is fresh (below); GAS only for a stale or missing mirror |

History writes (`updateHistory`, `backfillHistory`) run inside a `LockService`
critical section: the 4-hourly refresh and a queued backfill genuinely can
overlap, and a read-modify-write race would silently drop observations. The
backfill crawls every window *before* taking the lock, so the critical section
lasts milliseconds.

### Static board mirror

`data/board.json` is published *inside the frontend's own Pages artifact* by
`deploy-pages.yml`, and the client reads it before it considers GAS at all:
**localStorage → `data/board.json` → GAS `/exec`**.

Three reasons, none of which the client-side fallback could reach:

- **Executions.** The board is ~99 % of the traffic and was ~99 % of the
  executions, all of them cache reads. Thirty of them can run at once per
  account; the rest queue, which is how a busy minute turned into a 12 s
  deadline expiring on someone's phone. A static file on the same CDN as the
  app has no such ceiling.
- **Cold start.** An Apps Script Web App that has not run recently answers the
  first request with a transient 404 — the reason `fetchBoard` retries three
  times. Static JSON has no warm-up.
- **Surviving a dead backend.** The localStorage fallback only helps a browser
  that has already loaded the board once. The mirror is the last good board for
  *every* visitor, including a first-time one arriving while GAS is down.

The mirror is fetched 20 minutes after the backend's 4-hourly refresh and
published by the same build that ships the bundle, so it trails the backend by
~20 minutes plus a build (~2 min). For a board of wholesale *closing* prices,
published once a day after market close, that lag is invisible.

**A mirror is a file, and a file cannot know it went stale.** The `stale: false`
and `age_ms` inside it froze the moment it was written, so the client recomputes
the age from `generated_at` against the backend's own `BOARD_MAX_AGE_MS` (6 h,
mirrored in `src/lib/utils/freshness.ts`): under it, the mirror answers the
visit outright and is written to localStorage; over it, the prices still paint
immediately and the read continues to GAS. **The self-heal chain is therefore
unchanged** — a stale mirror sends the client to `/exec`, whose `readBoard`
queues the rebuild exactly as before. The mirror is a layer in front of GAS,
never a replacement for it.

What each failure does, in the order the client meets them:

| Failure | Client |
| --- | --- |
| No mirror deployed yet (404) | the pre-mirror path: GAS, with the localStorage fallback |
| Mirror is a truncated file, an error page, or breaks the §3 contract | reports `board_schema_mismatch` and asks GAS |
| Mirror does not answer within 3 s | asks GAS — a CDN that slow is only delaying the request its absence makes necessary |
| Mirror is stale **and** GAS is down | the stale mirror stays on screen with the connection note (`board_fallback`, `served: 'static'`) |

The publish side is symmetric: a mirror is only overwritten by a payload that
passes `frontend/scripts/validate-board.mjs` (the §3 contract, ≥ 60 items,
crawled < 8 h ago, every item priced), and a failed fetch or a rejected board
re-publishes the *previous* mirror rather than failing the deploy — a code
change must not be blocked by a backend outage, and an unvalidated file would
serve wrong prices for four hours (§8).

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
`alert.last_sent` / `alert.recipient_configured` — never the address, since
`diag` is public. The recipient is not in the source either: `alertRecipient()`
reads the `ALERT_EMAIL` script property, and that property is **required** —
there is deliberately no fallback to the deploying account's e-mail, because
reading it needs the `userinfo.email` scope the manifest does not grant, and
adding a scope forces re-consent before the Web App runs again. Unset, every
mail fails as `no_recipient` and `diag` shows `recipient_configured: false`.
`?action=alerttest` needs the operator token; its limiter stays
as defence in depth and is a durable timestamp rather than a cache key, since
cache eviction would otherwise re-open the endpoint.

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
| `suspect` | the item's numbers are plausible; it appears only on an item the guard flagged (§2), whose change and baseline the client must then hide |

`date` is the trading date; `generated_at` is when the backend crawled. See
"Trading date vs. refresh time" in §2 — clients must not present the trading date
alone as "last updated". `stale: true` means the board is past its max age and a
rebuild has been queued (`refresh_queued`); the stale board is still served.

The same payload is mirrored as a static file at
`https://sean1093.github.io/VeggieRadar/data/board.json`, which the client
reads *before* `/exec` (§2). It is the response of one past `?action=board`
call, byte for byte — including `age_ms` and `stale`, which are therefore
frozen at publish time and must be recomputed from `generated_at` by anything
reading the file.

`frontend/src/types/board.schema.ts` is the executable form of this contract:
the client's types are inferred from it, `api.ts` measures every live board
against it, `backendCode.test.ts` runs the real `buildBoard()` output through
it, and the production probe (§8) checks the deployed endpoints with it — so a
field renamed on one side of the wire fails in CI instead of reaching a
shopper as `undefined`. A client mismatch is reported, never enforced: the
board still renders (`board_schema_mismatch`, §6).

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
GET {WEB_APP_URL}/exec?action=warm[&force=1&token=…]
→ { "type": "warm", "queued": true, "forced": false, "message": "已排入背景更新，約一分鐘後生效", "board": { ... } }

GET {WEB_APP_URL}/exec?action=backfill&token=…[&force=1]
→ { "type": "backfill", "queued": true, "message": "已排入背景回填，約數分鐘後生效",
     "history": { "items": 97, "min_days": 1, "max_days": 24 } }
→ { "type": "backfill", "error": "unauthorized", "message": "此操作需要 token 參數" }   # wrong or missing token

GET {WEB_APP_URL}/exec?action=diag[&token=…]
→ { "type": "diag", "board": { "generated_at": ..., "stale": false },
     "triggers": ["refreshBoardCache"], "last_refresh_ok": "...", "last_refresh_fail": null,
     "last_validation": { "at": "2026-09-02T16:05:08.087Z", "ok": true, "reasons": [], "suspects": [] },
     "history": { "items": 97, "min_days": 1, "max_days": 24 },
     "alert": { "failure_streak": 0, "incident_open": false, "last_sent": null, "recipient_configured": true } }

GET {WEB_APP_URL}/exec?action=alerttest&token=…
→ { "type": "alerttest", "sent": true, "message": "已寄出測試信" }
```
`warm` and `backfill` both queue their crawl in a one-off trigger and answer at
once — the crawls take minutes and would blow the Web App response window.
`backfill` is idempotent per trading date, so re-running only fills gaps. `diag`
is how you tell "markets closed" from "refresh pipeline dead" without the GAS
console, and how you confirm history coverage after a backfill.

`last_validation` is public with or without the token, unlike `last_refresh_fail`:
its reasons are our own rule text and our own item names, never MOA or platform
text that could quote something we would rather not publish.

| Action | Anonymous | With `token` |
| --- | --- | --- |
| `board`, `search`, `getTrend` | ✅ | — |
| `warm` | ✅ (`force` ignored, `forced: false`) | ✅ `force` honoured |
| `backfill`, `alerttest` | ❌ `unauthorized` | ✅ |
| `diag` | ✅ failure reason as a category | ✅ raw failure reason |

`token` must equal the `ADMIN_TOKEN` script property; see §2 and §7.

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

Three tiers, most specific first:

| Tier | Table | Crops | Band |
| --- | --- | --- | --- |
| 1 | `RETAIL_MARKUP_ROOT` | 30 | fitted midpoint, band `× 0.75 … × 1.35` |
| 2 | `RETAIL_BAND_ROOT` | 21 | fitted `[p10, median, p90]` of the crop's own markup distribution |
| 3 | `RETAIL_MARKUP_CATEGORY` | the rest | one hand-tuned band per category |

Everything is rounded outward to NT$5, because stalls price in round numbers and
implying single-digit precision on an estimate would be dishonest. Board items
on the coarse tier-3 fallback dropped from **72 of 104 to 50**.

### Calibration and accuracy

Markups are fitted by joining MOA wholesale to two municipal retail feeds:

| Source | Granularity | Coverage |
| --- | --- | --- |
| [臺中市公有零售市場每日蔬果價格表](https://data.gov.tw/dataset/84539) | daily, 14 markets | 42 produce items, rolling 365 days (4,425 rows) |
| [臺北市公有零售市場行情](https://data.taipei/dataset/detail?id=54d9d492-1e2e-40d1-ae7b-fbce6f271bf1) | monthly | 122 items × **18 monthly snapshots** |

Both are keyless JSON quoting `元/台斤` — the same unit the app displays, so no
conversion is involved on the retail side. A survey for a third municipal feed
found none: Kaohsiung, Tainan and New Taipei publish no retail produce series,
and data.gov.tw's dataset search API is broken (405/404).

**Tier 2 exists because the Taipei feed was under-used.** Only one of its 18
monthly snapshots had ever been joined. Using all 18 gives paired observations
for 64 crops — but the obvious next step, extending tier 1's rule to them, made
accuracy *worse*, which is why the two tables have different shapes.

Held-out accuracy on the crops tier 2 covers (most recent 20% of each crop's
observations, fitted on the older 80% — 20 crops, 59 observations):

| Rule | Band coverage | Median abs. error |
| --- | --- | --- |
| Category fallback (previous behaviour) | 79.7% | **17.3%** |
| Per-crop midpoint with tier 1's `× 0.75 … × 1.35` band | 51.9% | 17.0% |
| Per-crop `[p10, median, p90]` (**shipped**) | **81.4%** | **6.8%** |

The midpoint's error falls by 61% and coverage improves slightly, so the
drawer's 「機率約八成」 stays true for these crops too. Three constraints decide
what is listed, each of them the result of a measurement that contradicted the
obvious guess:

1. **Quantiles, not a multiple of the midpoint.** Tier 1's fixed band applied
   here *lost* coverage against the fallback it was meant to beat — the spread
   is not proportional to the markup.
2. **Taipei-derived crops only.** A crop with daily Taichung coverage has enough
   observations for a tier-1-style fit and belongs in that pipeline. An earlier
   cut mixed both sources and produced a flattering blended figure that hid a
   coverage collapse on the Taichung side — 雜柑, 甜橙 and 海梨柑 are excluded
   for this reason.
3. **The band must be strictly tighter than the category band it replaces**,
   or the per-crop number is less informative than the default. This excludes
   竹筍, 蘆筍, 菠菜, 芹菜, 萵苣菜 and 李 — spread genuinely huge, usually because
   one MOA root spans varieties trading far apart (綠竹筍 vs 麻竹筍, §5) — and
   豌豆, 洋香瓜, whose fitted spread came out *exactly* as wide as their category.

龍眼 and 枇杷 are absent for a duller reason: 5 observations each, below the 8
this needs. Their seasons are too short.

The **tier-1 numbers are deliberately untouched.** The pipeline reproduces them
to a median of NT$2 — a useful check that the join, units and dates line up —
but they were fitted on a window that overlaps this holdout, so any comparison
flatters them. Replacing working constants on a contaminated measurement would
be a guess dressed as an improvement.

That residual error is why the UI shows a range rather than a single number, and
why the drawer says 「非實際報價」. Both feeds are used *offline* to derive the
constants; the runtime has no dependency on them, so the retail band adds no
network call and no failure mode.

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

## 6. Analytics

`index.html` loads GA4. Page views alone could not answer the questions the
roadmap keeps deferring on ("does anyone use 划算優先?") or size the degraded
modes §2 describes, so the app sends a small set of events through one typed
wrapper, `src/lib/analytics.ts`. Each event exists to settle a decision:

| Event | Params | Decision it informs |
| --- | --- | --- |
| `board_loaded` | `source` (`static` / `gas`), `stale`, `age_bucket` | Baseline for every ratio below; `source` is how the mirror's share of the reads is measured — the number that says whether GAS still carries the board (§2). A cache paint sends nothing: it is not yet a load |
| `board_fallback` | `served` (`static` / `cache` / `none`) | Fallback rate. `static` means the mirror went stale *and* GAS is down — a pipeline incident; `cache` is one browser's own copy saving one visit |
| `search_result` | `outcome` (`local_hit` / `remote_hit` / `not_found` / `transient`), `query_length` | Live-miss and busy rates → the search index in #21; whether the 15 s deadline holds |
| `sort_changed` | `mode` | 划算優先 adoption → 「今日推薦」 (§9) |
| `filter_changed` | `filter` | Which categories and 關注 get used |
| `watch_toggled` | `on`, `count_bucket` | Whether a watchlist summary is worth building |
| `drawer_opened` | `has_varieties`, `has_baseline`, `has_retail` | Whether §5's variety breakdown and baseline are ever seen |
| `trend_result` | `outcome` (`ok` / `empty` / `failed`), `reason` | Whether the trend deadline is right; memo hits are not reported |
| `chunk_failed` | `chunk` | Cost of the code split |
| `board_schema_mismatch` | `path` | Whether the backend's payload has drifted from the contract in §3 — a nonzero rate means some field is quietly missing from the UI while the board still renders |

What is deliberately **not** sent: the search text (only its outcome and
length — a search box accepts anything), watched item names (only a count
bucket), and anything else that could identify a person. Ages and counts are
bucketed so GA4 can aggregate them. `track()` is a no-op without `gtag`
(tests, offline, ad blockers) and swallows a throwing `gtag`: analytics can
never take the board down. Geography needs no event — GA4's built-in city
dimension is what decides the regional board (#23).

---

## 7. Local development

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
                       # every ../backend/*.gs with stubbed GAS services
npm test               # vitest in watch mode
npm run test:coverage  # v8 coverage report
./scripts/icons.sh     # rasterise public/icon-*.png from favicon.svg (needs librsvg);
                       # only after the brand mark changes — the PNGs are committed
```
250 tests at ~97% statement / ~90% branch coverage. `vitest.config.ts` pins
`TZ=Asia/Taipei`: the freshness assertions are written in the audience's local
time and would otherwise pass only on machines in that zone (a UTC CI runner
caught exactly that).

### What is committed, and why it is safe

Two files look like secrets and are not:

| File | Contents | Why committing it is fine |
| --- | --- | --- |
| `.clasp.json` | `scriptId` | An identifier, not a credential — like a Drive file ID. Verified anonymously: `script.google.com/d/<scriptId>/edit` returns **302 to Google login**, and the Apps Script API returns **401**. Access is gated by the project's Drive ACL plus OAuth, so this is safe *as long as the project is never link-shared*. |
| `frontend/.env` | `VITE_API_BASE_URL` | The `/exec` endpoint is public by necessity — the browser calls it. Vite also **inlines every `VITE_*` variable into the client bundle**, so this file is public whatever git does with it. A test asserts it holds nothing else. |

The actual credentials live outside the repo and must stay there: `~/.clasprc.json`
(your OAuth refresh token) and the `GCP_SA_KEY` / `CLASP_TOKEN` repo secrets.
The root `.gitignore` covers them plus `gcp-sa-key.json`, which the GAS deploy
workflow writes *into the checkout* at runtime — harmless on a throwaway runner,
a live credential in a commit anywhere else. It also ignores `node_modules/`
and `dist/`, because tooling run from the repo root creates them where
`frontend/.gitignore` cannot see them — which is how a stray vitest cache file
got committed once.

`frontend/repoHygiene.test.ts` asks **git** whether each dangerous path is
ignored (`git check-ignore`) rather than pattern-matching the ignore file:
only git implements gitignore semantics, including the `!frontend/.env`
negation that keeps the one intentional env file tracked. It also asserts that
nothing credential-shaped, and no dependency, build or coverage output, is tracked.

### Backend (Google Apps Script)
Code lives in `backend/*.gs`, deployed with `clasp` (`.clasp.json` sets
`rootDir` to `backend/`; no `filePushOrder`, see §2).
1. `clasp push`, then deploy as a **Web App** (execute as: me; access: anyone).
   `clasp push` only moves HEAD — the `/exec` URL serves a pinned version, so
   redeploy the same deployment to publish code:
   `clasp deploy -i <deploymentId> -d "<description>"`.
2. In the editor, **Project Settings → Script Properties**, add:
   - `ADMIN_TOKEN` — a long random string, e.g. `openssl rand -hex 32`. It
     gates `warm&force`, `backfill` and `alerttest` (§2); an empty value
     counts as unset (everything refused). It travels as a URL query
     parameter: the CI deploy URL-encodes it, but when you paste it into a
     browser or a hand-written `curl` a value containing `+`, `&` or `#` is
     mangled before it reaches `e.parameter` — hex avoids the question. Keep
     it out of the repo; CI reads it from the `GAS_ADMIN_TOKEN` secret (§8).
     There is one token, with no expiry or scope: rotating it means changing
     both places.
   - `ALERT_EMAIL` — **required**: where failure alerts go. Unset, no alert
     can be sent (`diag` shows `recipient_configured: false`, and
     `?action=alerttest` answers `no_recipient`). See §2 for why there is no
     fallback to the deploying account.
3. Run `installDailyTrigger()` once in the editor — it installs the refresh
   trigger on `REFRESH_INTERVAL_HOURS` and warms the board so the first visitor
   never hits a cold crawl. Confirm with `?action=diag`: `triggers` must list
   `refreshBoardCache`. Running it also grants the mail scope the alerting
   needs; `?action=alerttest&token=…` confirms a mail actually arrives.
4. Hit `?action=backfill&token=…` once to seed the baseline history (the crawl
   takes a few minutes), then confirm `diag.history.items` is non-zero. Until it
   is, the board simply ships without baseline fields and the UI hides the badge
   and the 划算優先 sort.
5. Put the Web App `/exec` URL in `frontend/.env` as `VITE_API_BASE_URL`.

> The MOA API needs no key.

---

## 8. Deployment

- **CI** via `.github/workflows/ci.yml`: every pull request runs ESLint, the
  suite and a typecheck/build. Pushes are gated inside the deploy workflows
  themselves (both run lint and the suite before publishing), so a red check
  blocks either surface without duplicating the run. Dependabot
  (`.github/dependabot.yml`) opens weekly PRs for the frontend toolchain and
  the workflow actions; those PRs run the same gate.
- **Frontend → GitHub Pages** via `.github/workflows/deploy-pages.yml`: pushing to
  the default branch runs the tests, builds `frontend/` and publishes to Pages. In
  the repo, set **Settings → Pages → Source: GitHub Actions**. Live at
  `https://<user>.github.io/VeggieRadar/` (`vite.config.ts` `base` is `/VeggieRadar/`).
  It also runs on `schedule: '20 */4 * * *'`, because the static board mirror
  (§2) is only as fresh as the last deploy: 20 minutes past the hour catches a
  board the backend's own 4-hourly trigger has already rebuilt rather than the
  one being replaced. Six extra deploys a day sits far below Pages' soft limit
  of ten per hour, and `concurrency: pages` still keeps one deploy at a time.
  The **Fetch board mirror** step runs after the suite and before the build:
  it `curl`s `?action=board` (the URL read from the committed `frontend/.env`,
  so no secret), validates it with
  `node --experimental-strip-types scripts/validate-board.mjs`, and copies it
  to `frontend/public/data/board.json` — which `frontend/.gitignore` covers,
  since the file belongs in the artifact and not in the history. **The step
  never fails the job**: a failed fetch or a rejected board re-publishes the
  mirror already on Pages, and if that is missing too the site deploys without
  one and the client goes straight to GAS. Every run records which of the three
  happened in its step summary:
  ```
  mirror: fresh | reused (stale) | none

  reason: board ok: 94 items, traded 2026-09-03, crawled 3.3 h ago
  ```
- **Backend → Apps Script** via `.github/workflows/deploy-gas.yml` (optional):
  otherwise deploy manually with `clasp` (§7). The workflow runs lint and the
  backend regression tests, pushes, **redeploys the pinned `DEPLOYMENT_ID`** —
  without that step `/exec` keeps serving old code — and then queues a board
  refresh via `?action=warm&force=1&token=…`, reading the token from the
  `GAS_ADMIN_TOKEN` secret (the same value as the `ADMIN_TOKEN` script
  property, §7). Apps Script always answers HTTP 200, so the step checks the
  body: `forced: false` with the secret set means the secret and the script
  property have drifted apart, and the job fails there rather than let the
  new deploy serve the old board. Without the secret it still queues a
  refresh, just subject to the 15-minute lock. It authenticates to Apps Script
  with **one** of two repo
  secrets (Settings → Secrets and variables → Actions), and skips the deploy
  with a notice when neither is set:
  - `GCP_SA_KEY` (recommended): a GCP service-account JSON key, base64-encoded,
    for an account that has edit access to the Apps Script project. The
    workflow decodes it into `gcp-sa-key.json` inside the checkout, which the
    root `.gitignore` covers for exactly that reason.
  - `CLASP_TOKEN` (simpler, less safe): the `refresh_token` from your local
    `~/.clasprc.json` after `clasp login`. It is your personal OAuth grant, so
    rotate it if the secret ever leaks.

> A board rebuilt out of band — after `warm`, or after a backfill — reaches the
> mirror only on the next scheduled deploy, up to four hours later. Running
> `deploy-pages` by `workflow_dispatch` refreshes it immediately; visitors see
> the new prices either way, since a mirror older than 6 h sends the client to
> GAS (§2).

> Both deploy workflows need Node 22+: the suite uses `Promise.withResolvers`.

### Monitoring

Every alarm above this line runs **inside** whatever breaks. The failure mail
(§2) is sent by the same Apps Script project whose deploy, OAuth scopes or
mail quota is the likely fault, and the frontend hides an outage behind its
cached board on purpose. `.github/workflows/prod-probe.yml` therefore watches
production from outside, every 6 hours at :40 — offset from the 4-hourly
refresh so a probe never lands while a crawl is replacing the board. It runs
one script, `frontend/scripts/prod-probe.mjs`, which imports the same schema
the app uses (§3) under Node's type stripping rather than keeping a copy that
could drift:

| Check | Passes when | Failure category |
| --- | --- | --- |
| `pages` | 200, `<title>` still contains 今日菜價, and a `<script type="module">` is present — a Pages deploy that lost its bundle still serves a plausible shell | `pages_down` |
| `mirror` | `data/board.json` is 200, matches the schema and was crawled < 8 h ago — the same bound the publish-side validator applies (§2). **A 404 stays `skipped`**, not a failure: a deploy that could obtain no mirror at all publishes without one on purpose, and the visitors it sends to GAS are covered by `gas_board` below | `mirror_stale` |
| `gas_board` | the body is JSON (Apps Script answers platform errors with HTML and HTTP 200), matches the schema, `stale === false`, `count ≥ 60`, crawled < 8 h ago | `gas_error` / `gas_stale` |
| `gas_diag` | `?action=diag` answers JSON | `gas_error` |
| `gas_trigger` | `triggers` includes `refreshBoardCache` | `trigger_missing` |
| `gas_incident` | `alert.incident_open === false` | `incident_open` |
| `gas_history` | `history.items ≥ 60` | `history_thin` |

`60` is `BOARD_HEALTHY_ITEMS` in `board.schema.ts`: a typical day publishes
~90 of ~100 defined items (§1), and MOA throttling a batch shows up as a board
that is complete enough to serve yet clearly short. It sits deliberately above
`BOARD_MIN_ITEMS` (30), the hard floor below which the backend refuses to
publish at all, so degradation is reported while the board still works.

**Freshness is judged on `generated_at` alone — `date` is never compared with
today.** The trading date legitimately stands still over weekends, holidays and
typhoon closures (§2, "Trading date vs. refresh time"), so a `date`-based check
would page a human every Sunday and be ignored by the second one.

A failing run comments on the open issue labelled **`prod-alert`**, and only
opens `[prod-alert] <categories> since <date>` when there is none (creating the
label on first use). A fully passing run comments 「recovered」 on that issue
and closes it. So at most one alert is ever open: a fresh issue every 6 hours
would bury the first one and train its reader to ignore the label — the same
reason the e-mail alerting has an incident window. The job also goes red
whenever the probe did, and appends the summary table to the run's step
summary. It needs no secret; every endpoint it touches is public (§2).

```bash
cd frontend
node --experimental-strip-types scripts/prod-probe.mjs   # writes probe-result.json, exit 1 on any failure
```
The flag is required on Node 22.6–22.17 and a no-op from 22.18 on.
`workflow_dispatch` takes `pages_url` / `api_base_url` inputs, so the alert
path can be exercised against a deliberately bad URL instead of waiting for a
real outage.

Not UptimeRobot or a similar service: Actions is already free here, and what
has to be verified is the schema and the freshness rather than an HTTP 200 —
a dead pipeline serves a perfectly healthy-looking board.

---

## 9. Roadmap

- Per-variety baselines. Today's baseline is blended across varieties (blend vs.
  blend is self-consistent, and the median resists mix rotation), while the
  variety breakdown is same-day only.
- A rules-based 「今日推薦」 strip on top of the board — deliberately deferred
  until the 划算優先 sort proves the demand (`sort_changed`, §6).
- Recalibrate the retail markups periodically against the Taichung daily feed;
  the current constants were fitted on data through 2026-08.
- Per-region retail bands (the calibration feeds are Taichung + Taipei only).
- Per-market / per-region filtering.
- Line Bot lookups (`doPost` is reserved).

## License
[MIT](LICENSE).
