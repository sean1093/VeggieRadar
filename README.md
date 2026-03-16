# Taiwan Produce Gemini Sentinel (TPGS)

## 1. Project Overview
The Taiwan Produce Gemini Sentinel (TPGS) is an intuitive, aesthetically pleasing, and AI-powered tool designed to provide real-time and analyzed information on Taiwan's fruit and vegetable market prices. Its primary objective is to bridge the information gap often found in traditional markets, making price trends and purchasing advice accessible to a wider audience.

*   **Objective:** To provide an intuitive, beautiful, and AI-powered Taiwanese fruit and vegetable market price inquiry tool, reducing information asymmetry in traditional markets.
*   **Target Audience:** Mobile-savvy young people and elderly individuals (grandmothers) who frequent traditional markets.
*   **Core Value:** Information transparency, simplified decision-making, and a modern interface.

## 2. Features

### Frontend (User Interface)
*   **Card-First Design:** Each produce item is presented in a card format, initially displaying only "Product Name," "Today's Average Price," and "Price Change Label."
*   **Progressive Disclosure:** Details are hidden by default. Clicking a card reveals a "Seven-Day Trend Chart," "Trading Volume," and "AI Advice" via a Drawer or Dialog.
*   **Visual Color Cues:**
    *   **Green (Down):** Indicates falling prices (good value, recommended to buy).
    *   **Red (Up):** Indicates rising prices (more expensive, consider alternatives).
*   **Minimalist Interface:** Reduces unnecessary borders and table lines, with ample whitespace for readability, especially for older users.
*   **Multi-dimensional Filtering:** Filter produce items by categories like "Popular," "Leafy Greens," "Root Vegetables," and "Fruits."

### Backend (API & Data)
*   **Daily Data Fetching:** A Google Apps Script (GAS) crawler fetches data daily from the Council of Agriculture's open data API for wholesale market transactions.
*   **Data Preprocessing:** Filters out items with low trading volume and calculates price changes from the previous day.
*   **AI-Powered Summaries:** Integrates with the Gemini 1.5 Flash AI to generate plain-language "purchasing tips" based on price trends, tailored for general consumers.
*   **JSON API Endpoint:** Provides frontend with structured JSON data for produce market prices.

## 3. Tech Stack (0-Cost Architecture)
*   **Frontend:** React (Vite) + TypeScript + Tailwind CSS + shadcn/ui. Deployed on GitHub Pages.
*   **Backend:** Google Apps Script (GAS) - Supports Web App API and future Line Bot Webhook.
*   **Database:** Google Sheets (for data storage, historical records, and simple caching).
*   **Data Source:** 農業部農產品批發市場交易行情 (Council of Agriculture Agricultural Products Wholesale Market Transaction Data - Open Data API).
*   **AI Engine:** Gemini 1.5 Flash (for market trend summaries and purchasing advice).

## 4. System Architecture

1.  **Crawler (GAS):** Triggered daily to fetch data from the Council of Agriculture API, calculate price changes, and update Google Sheets.
2.  **AI Analyst (Gemini):** Daily identifies top 5 price gainers and losers to generate a concise, easy-to-understand "Purchasing Guide."
3.  **API Gateway (GAS):**
    *   `doGet`: Provides frontend with JSON formatted market data.
    *   `doPost`: (Reserved) For future integration with Line Bot Webhook message replies.
4.  **Web Client (Frontend):** Deployed on Vercel or GitHub Pages, it fetches data from the GAS API and renders the user interface.

## 5. Development Plan & Task Breakdown (Completed & Next Steps)

### Phase 1: Backend & Data Foundation (GAS & Sheets) - **Completed**
*   Established Google Sheets data tables (`LivePrice` and `HistoryLog`).
*   Developed GAS crawler to connect to the Council of Agriculture API with pagination.
*   Implemented data preprocessing (filtering low-volume items, calculating price change percentage).
*   Implemented `doGet` API to return JSON with `items` array and `ai_summary`.
*   Integrated Gemini API for generating plain-language "purchasing tips."

### Phase 2: Frontend Implementation (React + Vite) - **Completed**
*   Initialized Vite + Tailwind CSS environment, configured `shadcn/ui` base theme.
*   Implemented main page `Header` (with search) and `ProduceGrid` layout.
*   Implemented `ProduceCard` component with large fonts and clear color labels.
*   Used `Recharts` to draw a minimalist 7-day price trend chart.
*   Implemented multi-dimensional filtering functionality.

### Phase 3: UX Detail & Optimization - **In Progress**
*   **Task 3.1:** Implement `DetailDrawer` component to display hidden detailed information.
    *   _Current Status:_ `DetailDrawer` component implemented using `shadcn/ui` Dialog. Interface `ProduceItem` updated across `App.tsx`, `ProduceGrid.tsx`, and `ProduceCard.tsx` to include detailed fields. `App.tsx` updated to manage drawer state and pass `onCardClick` handler.
*   **Task 3.2:** Implement "Alternative Suggestions" feature: If a vegetable's price increase is too high, automatically recommend "currently cheaper similar items."
    *   _Current Status:_ `getAlternativeSuggestions` utility function and its tests implemented. Integrated into `DetailDrawer` with data passed from `App.tsx`.
*   **Task 3.3:** Configure PWA (Vite PWA Plugin) for mobile home screen installation.
    *   _Current Status:_ **Blocked.** `vite-plugin-pwa` is currently incompatible with `Vite 8`. This task cannot be completed until a compatible version of the plugin is released.

### Phase 4: Future Expansion (Line Bot Support)
*   **Task 4.1:** Establish `LineBotHandler` module in GAS for Webhook verification.
*   **Task 4.2:** Design keyword query logic (e.g., input "高麗菜" to return latest price).

## 6. Local Development Setup

To get the project running locally, follow these steps:

### Frontend
1.  **Navigate to the frontend directory:**
    ```bash
    cd frontend
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
    _Note: Ensure your Node.js version is `20.19+` or `22.12+` to avoid potential `rolldown` and other dependency issues._
3.  **Start the development server:**
    ```bash
    npm run dev
    ```
    This will typically open the application in your browser at `http://localhost:5173`.

### Backend (Google Apps Script)
1.  **Create a new Google Apps Script project:** Go to `script.google.com`.
2.  **Copy `Code.gs` content:** Paste the content of `Code.gs` into your GAS project.
3.  **Update Configuration:** Replace placeholder values in `Code.gs` (e.g., `AGRICULTURE_API_URL`, `GEMINI_API_KEY`, `SHEET_ID`) with your actual API URLs and keys.
4.  **Set up Google Sheets:** Create Google Sheets for `LivePrice` and `HistoryLog` as per the project plan.
5.  **Deploy as Web App:**
    *   In GAS editor, click `Deploy` -> `New deployment`.
    *   Select `Web app` as the type.
    *   Configure execution access (e.g., `Me`) and who has access (e.g., `Anyone`).
    *   Note the Web App URL. This will be your backend API endpoint.

## 7. Deployment to GitHub Pages (Frontend)

To deploy the frontend to GitHub Pages:

1.  **Push to your GitHub repository:**
    ```bash
    git branch -M main
    git remote add origin https://github.com/YOUR_USERNAME/tw-produce-gemini-sentinel.git # Replace YOUR_USERNAME
    git push -u origin main
    ```
2.  **Run the deploy script:**
    ```bash
    cd frontend
    npm run deploy
    ```
    This will build your application and push it to the `gh-pages` branch.
3.  **Configure GitHub Pages:**
    *   Go to your GitHub repository settings -> "Pages" section.
    *   Under "Build and deployment", select "Deploy from a branch".
    *   Choose the `gh-pages` branch and `/ (root)` folder.
    *   Click "Save".

Your site should then be accessible at `https://YOUR_USERNAME.github.io/tw-produce-gemini-sentinel/`.

## 8. Contributing

Contributions are welcome! Please follow these steps:
1.  Fork the repository.
2.  Create a new branch (`git checkout -b feature/your-feature-name`).
3.  Make your changes.
4.  Ensure all tests pass and add new tests for new features.
5.  Commit your changes (`git commit -m 'feat: Add new feature'`).
6.  Push to the branch (`git push origin feature/your-feature-name`).
7.  Open a Pull Request.

---

## License

[MIT License](LICENSE) (to be added)
