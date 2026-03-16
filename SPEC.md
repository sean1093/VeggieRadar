# SPEC.md: Taiwan Produce Gemini Sentinel (TPGS)

## 1. Project Overview
* **Repo Name:** `tw-produce-gemini-sentinel`
* **Objective:** 提供一個直覺、美觀且具備 AI 分析功能的台灣蔬果行情查詢工具，縮短傳統市場資訊落差。
* **Target Audience:** 習慣使用手機的年輕人與常逛傳統市場的長輩（婆婆媽媽）。
* **Core Value:** 資訊透明化、決策簡單化、介面現代化。

---

## 2. Tech Stack (0-Cost Architecture)
* **Frontend:** React (Vite) + TypeScript + Tailwind CSS + shadcn/ui.
* **Backend:** Google Apps Script (GAS) - 支援 Web App API 與未來 Line Bot Webhook。
* **Database:** Google Sheets (作為資料存儲、歷史紀錄與簡單 Cache)。
* **Data Source:** 農業部農產品批發市場交易行情 (Open Data API)。
* **AI Engine:** Gemini 1.5 Flash (負責行情趨勢摘要與採購建議)。

---

## 3. UI/UX Design Principles
* **Card-First Design:** 每個蔬果以卡片形式呈現，預設僅顯示「品名」、「今日均價」、「漲跌幅標籤」。
* **Progressive Disclosure:** 預設隱藏細節。點擊卡片才透過 Drawer 或 Dialog 展開「近七日趨勢圖」、「交易量」、「AI 建議」。
* **Visual Color Cues:** * **綠色 (Down):** 代表價格下跌（便宜，推薦購買）。
    * **紅色 (Up):** 代表價格上漲（變貴，建議考慮替代品）。
* **Minimalist Interface:** 移除所有不必要的邊框與表格線，保留大量留白，確保長輩閱讀不吃力。

---

## 4. System Architecture
1.  **Crawler (GAS):** 每日定時觸發，抓取農業部 API 數據，計算漲跌幅後更新 Google Sheets。
2.  **AI Analyst (Gemini):** 每日抓取當日價格前 5 名與跌幅前 5 名，生成一段白話的「採購錦囊」。
3.  **API Gateway (GAS):** * `doGet`: 提供前端所需之 JSON 格式行情數據。
    * `doPost`: (預留) 供未來串接 Line Bot Webhook 訊息回傳。
4.  **Web Client (Frontend):** 部署於 Vercel 或 GitHub Pages，透過 Fetch 取得 GAS 數據並渲染。

---

## 5. Development Plan & Task Breakdown

### Phase 1: Backend & Data Foundation (GAS & Sheets)
* [ ] **Task 1.1:** 建立 Google Sheets 資料表 (`LivePrice` 與 `HistoryLog`)。
* [ ] **Task 1.2:** 撰寫 GAS 爬蟲，串接農業部 API 並實作分頁抓取邏輯。
* [ ] **Task 1.3:** 實作數據預處理：過濾掉交易量過低的品項，計算與昨日之價差 %。
* [ ] **Task 1.4:** 實作 `doGet` API，回傳包含 `items` 陣列與 `ai_summary` 的 JSON。
* [ ] **Task 1.5:** 整合 Gemini API，設計 Prompt 讓其產出適合婆婆媽媽看的「白話採購指南」。

### Phase 2: Frontend Implementation (React + Vite)
* [ ] **Task 2.1:** 初始化 Vite + Tailwind CSS 環境，配置 `shadcn/ui` 基本主題。
* [ ] **Task 2.2:** 實作主頁面 `Header` (含搜尋) 與 `ProduceGrid` 佈局。
* [ ] **Task 2.3:** 實作 `ProduceCard` 組件，使用大字體與清晰的顏色標籤。
* [ ] **Task 2.4:** 使用 `Recharts` 繪製「極簡風格」的七日價格曲線圖。
* [ ] **Task 2.5:** 實作多維度篩選功能 (熱門、葉菜、根莖、水果)。

### Phase 3: UX Detail & Optimization
* [ ] **Task 3.1:** 實作 `DetailDrawer` 組件，用於顯示隱藏的細節資訊。
* [ ] **Task 3.2:** 實作「替代方案」功能：若某蔬菜漲幅過大，底部自動推薦「現在更便宜的類似品項」。
* [ ] **Task 3.3:** 設定 PWA (Vite PWA Plugin)，讓網頁可安裝至手機主畫面。

### Phase 4: Future Expansion (Line Bot Support)
* [ ] **Task 4.1:** 在 GAS 中建立 `LineBotHandler` 模組，預備處理 Webhook 驗證。
* [ ] **Task 4.2:** 設計關鍵字查詢邏輯 (例如：輸入「高麗菜」回傳最新價格)。

---

## 6. Data Schema (GAS JSON Output)
```json
{
  "date": "2026-03-16",
  "ai_summary": "今天葉菜類普遍降價，尤其是高麗菜非常划算！",
  "items": [
    {
      "code": "LA1",
      "name": "甘藍-改良種",
      "avg_price": 25.4,
      "change_percent": -12.5,
      "trend": [28, 27, 29, 26, 25.4],
      "category": "葉菜類"
    }
  ]
}