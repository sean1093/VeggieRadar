# VeggieRadar 🥬

Today's Taiwan wholesale vegetable & fruit prices, at a glance. Open the app and
immediately see a calm, MUJI-inspired board of the produce people buy most —
green when cheaper, clay when pricier, priced per catty (台斤).

- **Audience:** shoppers at traditional markets and home cooks, primarily on phones.
- **Experience:** board-first and mobile-first. No typing required — the common
  produce board loads instantly; search is secondary.
- **Zero-cost stack:** GitHub Pages frontend + Google Apps Script backend, sourced
  from the Taiwan Ministry of Agriculture (MOA) open data. No paid services.

> Note on language: the **UI is in Traditional Chinese** (its audience); **code,
> comments, and this documentation are in English**.

---

## 1. Design principles

- **Board-first, no typing.** The home screen lists ~38 of the most-bought items
  as large, calm rows — scan and go.
- **Per-catty pricing.** Primary price is `元/台斤` (the market convention;
  1 catty = 600 g); `元/公斤` is shown as a secondary line. The MOA source is
  `元/公斤`, converted on the client (×0.6).
- **Colour as meaning.** Sage `↓ 便宜了` (cheaper), clay `↑ 變貴了` (pricier),
  grey `→ 持平` (flat), compared with the previous trading day. Arrows + text back
  up the colour so it never relies on colour alone.
- **Honest freshness.** A caption shows the data date and that it is the wholesale
  closing average — wholesale prices publish after market close, so the latest day
  with data is shown.
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
  - `refreshBoardCache()` — run by a time-driven trigger; crawls the common items
    with `UrlFetchApp.fetchAll` (concurrent) and stores the board in `CacheService`
    plus durable `ScriptProperties`.
  - `doGet` (default) — serves the stored board instantly. **It never crawls
    synchronously** (a cold crawl exceeds the Web App response window and 404s).
  - `doGet?action=search&query=<name>` — filters the board, falling back to a live
    query. Accepts Chinese and common English/colloquial terms via an alias table.
  - `doGet?action=getTrend&cropName=<name>&days=7` — price trend for the drawer.
  - `doGet?action=warm` — builds + stores the board (used by the trigger and for a
    one-time bootstrap).
  - Prices are volume-weighted averages across markets; items below 200 kg traded
    are filtered; the latest day with data is found automatically.
- **Frontend (`frontend/`):** React + Vite + TypeScript + Tailwind + shadcn/ui.
  Loads the board on mount; when `VITE_API_BASE_URL` is unset it uses a bundled
  sample board so the UI runs fully offline.

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
  "count": 38,
  "items": [
    {
      "code": "LA1",
      "name": "高麗菜",
      "official_name": "甘藍",
      "category": "葉菜類",
      "avg_price": 24.4,
      "catty_price": 14.6,
      "change_percent": -3.1,
      "trade_volume": 416301,
      "unit": "公斤",
      "markets_count": 6
    }
  ],
  "cached": true
}
```

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

## 4. Local development

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
npm test         # vitest
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

## 5. Deployment

- **Frontend → GitHub Pages** via `.github/workflows/deploy-pages.yml`: pushing to
  the default branch builds `frontend/` and publishes to Pages. In the repo,
  set **Settings → Pages → Source: GitHub Actions**. Live at
  `https://<user>.github.io/VeggieRadar/` (`vite.config.ts` `base` is `/VeggieRadar/`).
- **Backend → Apps Script** via `.github/workflows/deploy-gas.yml` (optional):
  set repo secrets `GAS_PROJECT_ID` + `GCP_SA_KEY` (or `CLASP_TOKEN`); otherwise
  deploy manually with `clasp`. See `clasp_instructions.md`.

---

## 6. Roadmap

- Longer historical trends and best-time-to-buy hints.
- PWA install to home screen (pending a `vite-plugin-pwa` build compatible with Vite 8).
- Per-market / per-region filtering.
- Line Bot lookups (`doPost` is reserved).

## License
MIT (to be added).
