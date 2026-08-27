# VeggieRadar 🥬

Today's Taiwan wholesale vegetable & fruit prices, at a glance — plus an
estimated traditional-market retail band so you can sanity-check a stall's price
while standing in front of it. Open the app and immediately see a calm,
MUJI-inspired board of the produce people buy most — green when cheaper, clay
when pricier, priced per catty (台斤).

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
- **Wholesale is the fact; retail is an estimate.** The board's headline number
  is the wholesale closing average. Below it, `市場約 35–55` is a *reference
  band* for a traditional market, never a quoted price — see §4.
- **Colour as meaning.** Sage `↓ 便宜了` (cheaper), clay `↑ 變貴了` (pricier),
  grey `→ 持平` (flat), compared with the previous trading day. Arrows + text back
  up the colour so it never relies on colour alone.
- **Honest freshness.** A caption shows the data date and that it is the wholesale
  closing average — wholesale prices publish after market close, so the latest day
  with real trades is shown.
- **MUJI aesthetic.** Paper background, ink text, hairline dividers, generous
  whitespace, restrained type. No loud colour, no heavy shadows.

---

## 2. Architecture

```
MOA open-data API ──▶ GAS daily cache (board) ──▶ Frontend board (GitHub Pages)
   (live queries)         (CacheService +            Header search is secondary
                           durable ScriptProperties)
```

- **Data source:** Taiwan MOA "Agricultural Products Wholesale Market Transactions"
  open data, no API key. `https://data.moa.gov.tw/api/v1/AgriProductsTransType/`
  (ROC-calendar dates, e.g. `115.08.26`; prices in `元/公斤`).
- **Backend (`backend/Code.gs`):**
  - `refreshBoardCache()` — run by a time-driven trigger; crawls the board items
    with `UrlFetchApp.fetchAll` (concurrent, batched at 13) and stores the board
    in `CacheService` plus durable `ScriptProperties`.
  - `doGet` (default) — serves the stored board instantly. **It never crawls
    synchronously** (a cold crawl exceeds the Web App response window and 404s).
  - `doGet?action=search&query=<name>` — filters the board, falling back to a live
    query. Accepts Chinese and common English/colloquial terms via an alias table.
  - `doGet?action=getTrend&cropName=<name>&days=7` — price trend for the drawer.
  - `doGet?action=warm` — builds + stores the board (used by the trigger and for a
    one-time bootstrap).
  - Prices are volume-weighted averages across markets; items below 200 kg traded
    are filtered; the latest day with real trades is found automatically.
- **Frontend (`frontend/`):** React + Vite + TypeScript + Tailwind + shadcn/ui.
  Loads the board on mount; when `VITE_API_BASE_URL` is unset it uses a bundled
  sample board so the UI runs fully offline.

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
the board (including 高麗菜) without any error; and `storeBoard()` splits the
~24 KB board across numbered `ScriptProperties` chunks, since a single property
value is capped at 9 KB.

---

## 3. API

### Board (default)
```
GET {WEB_APP_URL}/exec
```
```json
{
  "type": "board",
  "date": "2026-08-26",
  "roc_date": "115.08.26",
  "prev_date": "115.08.25",
  "count": 94,
  "items": [
    {
      "code": "LA1",
      "name": "高麗菜",
      "official_name": "甘藍",
      "category": "葉菜類",
      "avg_price": 23.4,
      "catty_price": 14,
      "retail_low": 35,
      "retail_price": 43,
      "retail_high": 55,
      "retail_estimated": true,
      "change_percent": -7,
      "trade_volume": 640155,
      "unit": "公斤",
      "markets_count": 13
    }
  ],
  "cached": true
}
```
`avg_price` is `元/公斤`; `catty_price` and all three `retail_*` fields are
`元/台斤`. `retail_estimated` is always `true` — see §4. Clients must treat the
`retail_*` fields as optional, since a board cached by an older deploy lacks them.

### Search
```
GET {WEB_APP_URL}/exec?action=search&query=高麗菜
```
Same `items` shape with `type: "search"`; no match returns `{ "error": "查無此品項" }`.

### Trend
```
GET {WEB_APP_URL}/exec?action=getTrend&cropName=甘藍&days=7
→ { "cropName": "甘藍", "days": 7, "trend": [23.1, 24.0, null, 24.4, ...] }
```
(`null` = no market that day, e.g. a holiday.)

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

## 5. Local development

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
npm run build    # tsc typecheck + vite build
npm test         # vitest — includes backendCode.test.ts, which loads
                 # ../backend/Code.gs with stubbed GAS services
```

### Backend (Google Apps Script)
Code lives in `backend/Code.gs`, deployed with `clasp` (`.clasp.json` sets
`rootDir` to `backend/`).
1. `clasp push` then deploy as a **Web App** (execute as: me; access: anyone).
2. Run `installDailyTrigger()` once in the editor — it installs the refresh
   trigger and warms the board so the first visitor never hits a cold crawl.
3. Put the Web App `/exec` URL in `frontend/.env` as `VITE_API_BASE_URL`.

> The MOA API needs no key.

---

## 6. Deployment

- **Frontend → GitHub Pages** via `.github/workflows/deploy-pages.yml`: pushing to
  the default branch builds `frontend/` and publishes to Pages. In the repo,
  set **Settings → Pages → Source: GitHub Actions**. Live at
  `https://<user>.github.io/VeggieRadar/` (`vite.config.ts` `base` is `/VeggieRadar/`).
- **Backend → Apps Script** via `.github/workflows/deploy-gas.yml` (optional):
  set repo secrets `GAS_PROJECT_ID` + `GCP_SA_KEY` (or `CLASP_TOKEN`); otherwise
  deploy manually with `clasp`. See `clasp_instructions.md`.

---

## 7. Roadmap

- Longer historical trends and best-time-to-buy hints.
- Recalibrate the retail markups periodically against the Taichung daily feed;
  the current constants were fitted on data through 2026-08.
- Per-region retail bands (the calibration feeds are Taichung + Taipei only).
- PWA install to home screen (pending a `vite-plugin-pwa` build compatible with Vite 8).
- Per-market / per-region filtering.
- Line Bot lookups (`doPost` is reserved).

## License
MIT (to be added).
