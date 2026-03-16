# SPEC.md: VeggieRadar - 台灣即時菜價查詢工具

## 1. Project Overview
* **Repo Name:** `VeggieRadar`
* **Objective:** 提供一個即時、直覺的台灣蔬果批發價格查詢工具。使用者輸入菜名或水果名稱，系統即時呼叫農業部 API，回傳當前批發價格，並以優質 UX 呈現。
* **Target Audience:** 習慣使用手機的年輕人與常逛傳統市場的長輩（婆婆媽媽）。
* **Core Value:**
  * **即時性：** 每次查詢都呼叫最新的農業部 API
  * **簡單直覺：** 輸入菜名即可查詢，無需複雜操作
  * **清晰呈現：** 以卡片式設計呈現價格、漲跌幅、產地等資訊

---

## 2. Tech Stack (0-Cost Architecture)
* **Frontend:** React (Vite) + TypeScript + Tailwind CSS + shadcn/ui.
* **Backend:** Google Apps Script (GAS) - 作為 API Proxy，即時呼叫農業部 API。
* **Cache (Optional):** Google Sheets - 可選擇性快取今日已查詢結果，減少 API 呼叫次數。
* **Data Source:** 農業部農產品批發市場交易行情 (Open Data API) - 即時呼叫。
* **Future Features:**
  * AI 建議功能（Gemini 1.5 Flash）
  * Line Bot 整合
  * 歷史價格趨勢圖

---

## 3. UI/UX Design Principles
* **Search-First Design:** 主要介面是搜尋框，使用者輸入菜名（如「高麗菜」、「番茄」）。
* **Instant Feedback:**
  * 輸入時提供自動完成建議
  * 查詢時顯示 Loading 狀態
  * 立即呈現查詢結果
* **Card Display:** 查詢結果以大卡片呈現：
  * 品名、今日均價（大字體）
  * 漲跌幅（綠色 ↓ 降價 / 紅色 ↑ 漲價）
  * 產地、單位
  * 若有多個品種，以清單方式呈現
* **Visual Color Cues:**
  * **綠色 (Down):** 代表價格下跌（便宜）
  * **紅色 (Up):** 代表價格上漲（變貴）
* **Minimalist Interface:** 簡潔設計，適合行動裝置使用。

---

## 4. System Architecture (Revised for Real-Time Queries)

### 查詢流程：
1. **使用者輸入** → 前端搜尋框（如「高麗菜」）
2. **前端呼叫 GAS** → `doGet?query=高麗菜`
3. **GAS 即時查詢** → 呼叫農業部 API，搜尋包含「高麗菜」的品項
4. **資料處理** →
   * 過濾低交易量品項
   * 計算漲跌幅（需要前一日資料）
   * 整理回傳格式
5. **回傳前端** → JSON 格式資料
6. **前端呈現** → 以卡片形式顯示結果

### 系統元件：
* **Web Client (Frontend):** React + Vite，部署於 GitHub Pages
* **API Proxy (GAS):**
  * `doGet(query)`: 接收查詢關鍵字，即時呼叫農業部 API
  * 快取機制：同一天的相同查詢結果可快取在 Google Sheets
* **Data Source:** 農業部農產品批發市場交易行情 API

---

## 5. Development Plan & Task Breakdown (Revised for Real-Time Search)

### Phase 1: 即時查詢核心功能
* [ ] **Task 1.1:** 研究農業部 API 查詢參數與回傳格式
* [ ] **Task 1.2:** 實作 GAS `doGet(query)` - 接收關鍵字，即時查詢 API
* [ ] **Task 1.3:** 實作關鍵字搜尋邏輯（模糊比對、多品種處理）
* [ ] **Task 1.4:** 資料處理：過濾低交易量、計算漲跌幅
* [ ] **Task 1.5:** （可選）實作 Google Sheets 快取機制

### Phase 2: 前端搜尋介面
* [x] **Task 2.1:** 初始化 Vite + Tailwind CSS + shadcn/ui
* [ ] **Task 2.2:** 實作搜尋框組件（自動完成、Loading 狀態）
* [ ] **Task 2.3:** 實作查詢結果卡片（價格、漲跌幅、產地）
* [ ] **Task 2.4:** 處理多個品種的顯示（清單或網格）
* [ ] **Task 2.5:** 行動裝置優化與 RWD

### Phase 3: UX 優化
* [ ] **Task 3.1:** 熱門搜尋建議（常見蔬果快捷按鈕）
* [ ] **Task 3.2:** 錯誤處理與友善提示
* [ ] **Task 3.3:** Loading 骨架屏動畫
* [ ] **Task 3.4:** PWA 支援（離線快取、可安裝）

### Phase 4: 進階功能（未來）
* [ ] **Task 4.1:** 歷史價格趨勢圖
* [ ] **Task 4.2:** AI 價格分析與建議（Gemini）
* [ ] **Task 4.3:** Line Bot 整合
* [ ] **Task 4.4:** 使用者收藏清單

---

## 6. API 規格

### Request (前端 → GAS)
```
GET https://script.google.com/macros/s/{SCRIPT_ID}/exec?query=高麗菜
```

### Response (GAS → 前端)
```json
{
  "query": "高麗菜",
  "date": "2026-03-16",
  "count": 2,
  "items": [
    {
      "code": "LA1",
      "name": "甘藍-改良種",
      "avg_price": 25.4,
      "change_percent": -12.5,
      "trade_volume": 50000,
      "category": "葉菜類",
      "origin": "台灣高山",
      "unit": "公斤",
      "market": "台北一市"
    },
    {
      "code": "LA1-B",
      "name": "甘藍-初秋",
      "avg_price": 28.0,
      "change_percent": 5.2,
      "trade_volume": 30000,
      "category": "葉菜類",
      "origin": "彰化",
      "unit": "公斤",
      "market": "台北二市"
    }
  ]
}
```

### 錯誤回應
```json
{
  "error": "查無此品項",
  "query": "不存在的菜名"
}
```