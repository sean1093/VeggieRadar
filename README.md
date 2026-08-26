# VeggieRadar 🥬 今日菜價

讓婆婆媽媽逛市場時，**一打開就看到今天常見菜的價格**，綠色↓便宜、紅色↑變貴，價格以熟悉的「元/台斤」顯示。

- **對象：** 到傳統市場買菜的長輩與家庭主婦（也適合手機族）。
- **核心體驗：** 看板優先（board-first）——打開就是今日常見菜價牌，**不需打字**。搜尋只是輔助。
- **零成本架構：** 前端 GitHub Pages + 後端 Google Apps Script，資料來自農業部開放資料，全部免費。

---

## 1. 設計原則（給長輩用）

- **看板優先，免打字：** 首頁直接列出約 38 種最常買的菜（高麗菜、番茄、蔥…），大字卡片、一眼掃過。
- **台斤為主：** 主要價格顯示「元/台斤」（市場習慣），下方附「元/公斤」。批發資料原始單位是元/公斤，前端換算 ×0.6。
- **顏色即語意：** 綠色↓「便宜了」、紅色↑「變貴了」、灰色→「持平」，和昨日收盤比較。
- **誠實標示時效：** 橫幅標「資料日期 YYYY-MM-DD（批發市場收盤均價）」。批發行情通常收盤後才更新，故顯示的是最近一個有資料的交易日。
- **分類篩選：** 葉菜類／根莖類／瓜果類／果菜類／辛香類／水果／其他，依當日資料自動產生。
- **點卡看細節：** 點任一張卡開啟詳情——7 日趨勢圖、交易量、同類更划算的替代建議。

---

## 2. 系統架構

```
農業部開放資料 API ──▶ GAS 每日快取（看板）──▶ 前端看板（GitHub Pages）
   (即時查詢)              (CacheService)          Header 搜尋為輔
```

- **資料來源：** 農業部「農產品批發市場交易行情」開放資料，免金鑰。
  `https://data.moa.gov.tw/api/v1/AgriProductsTransType/`（日期為民國格式，如 `115.08.26`；價格元/公斤）。
- **後端（`backend/Code.gs`）：**
  - `refreshBoardCache()`：由**每 6 小時的時間觸發器**呼叫，抓取常見菜、算好漲跌、寫入 `CacheService`，使用者永遠不必等爬取。
  - `doGet`（預設）：**即時**回傳快取好的看板，毫秒級。
  - `doGet?action=search&query=高麗菜`：先比對看板，找不到再即時查 API（含俗名別名表，如 高麗菜→甘藍）。
  - `doGet?action=getTrend&cropName=甘藍&days=7`：回傳價格趨勢（詳情抽屜用）。
  - 價格為**全市場成交量加權平均**；過濾交易量 < 200 公斤的零星品項；自動往前找最近一個有交易的日期。
- **前端（`frontend/`）：** React + Vite + TypeScript + Tailwind + shadcn/ui。掛載即載入看板；`VITE_API_BASE_URL` 未設定時使用內建範例資料離線可跑。

---

## 3. API 規格

### 看板（預設）
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
      "code": "LA0",
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

### 搜尋
```
GET {WEB_APP_URL}/exec?action=search&query=高麗菜
```
回傳同上 `items` 結構，`type` 為 `"search"`；查無結果回 `{ "error": "查無此品項" }`。

### 趨勢
```
GET {WEB_APP_URL}/exec?action=getTrend&cropName=甘藍&days=7
→ { "cropName": "甘藍", "days": 7, "trend": [23.1, 24.0, null, 24.4, ...] }
```
（`null` 代表當天無市場交易，例如假日。）

---

## 4. 本地開發

### 前端
```bash
cd frontend
npm install
npm run dev      # http://localhost:5173/VeggieRadar/
```
未設定 `VITE_API_BASE_URL` 時，自動使用 `src/services/mockBoard.ts` 的範例資料，UI 完整可操作。
連接真實後端：在 `frontend/.env` 設 `VITE_API_BASE_URL=<你的 GAS Web App /exec 網址>`。

```bash
npm run build    # tsc 型別檢查 + vite 打包
npm test         # vitest（27 個測試）
```

### 後端（Google Apps Script）
1. 程式碼在 `backend/Code.gs`，透過 `clasp` 部署（見 `clasp_instructions.md`，`.clasp.json` 的 `rootDir` 已設為 `backend/`）。
2. 部署為 **Web App**（執行身分：我；存取權：任何人）。
3. 在 GAS 編輯器執行一次 `installDailyTrigger()`：安裝每 6 小時的看板刷新觸發器並先暖一次快取。
4. 將 Web App 的 `/exec` 網址填入前端 `VITE_API_BASE_URL`。

> 本 API 不需金鑰。

---

## 5. 部署到 GitHub Pages（前端）
```bash
cd frontend
npm run deploy   # 打包並推到 gh-pages 分支
```
Repo Settings → Pages → Deploy from branch → `gh-pages` / root。
網址：`https://<USER>.github.io/VeggieRadar/`（`vite.config.ts` 的 `base` 已設為 `/VeggieRadar/`）。

---

## 6. 後續（未來）
- 歷史價格趨勢（更長區間）與最佳購買時機提示。
- PWA 加到主畫面（`vite-plugin-pwa` 需與 Vite 8 相容版本）。
- 依市場/地區篩選。
- Line Bot 查詢（`doPost` 已預留）。

## License
MIT（待補）。
