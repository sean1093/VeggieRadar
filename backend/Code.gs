/**
 * Google Apps Script (GAS) Code Template for VeggieRadar Project - Phase 1
 *
 * This script provides the backend for the VeggieRadar project,
 * focusing on fetching agricultural data and serving it as a JSON API via doGet().
 * AI functionality is temporarily disabled for Phase 1.
 */

// --- Configuration ---
const AGRICULTURE_API_URL = "YOUR_AGRICULTURE_OPEN_DATA_API_URL"; // 農業部農產品批發市場交易行情 API URL
const SHEET_ID = "YOUR_GOOGLE_SHEET_ID"; // Google Sheet ID for LivePrice and HistoryLog
// AI functionality disabled for Phase 1
// const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY";
// const GEMINI_API_URL = "YOUR_GEMINI_API_URL";

// --- Main Web App Entry Point ---
function doGet(e) {
  // Set CORS headers for web app
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (e.parameter.method == 'OPTIONS') {
    return ContentService.createTextOutput(JSON.stringify('')).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    // 1. Fetch data from Agriculture Open Data API
    const agricultureData = fetchAgricultureData();

    // 2. Process agriculture data (filter low volume, calculate change_percent)
    const processedItems = processAgricultureData(agricultureData);

    // 3. Construct the final JSON response (AI summary disabled for Phase 1)
    const currentDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    const responseData = {
      date: currentDate,
      items: processedItems.map(item => ({
        code: item.code,
        name: item.name,
        avg_price: item.avg_price,
        change_percent: item.change_percent,
        trend: item.trend,
        category: item.category,
        description: item.description || '',
        origin: item.origin || '',
        unit: item.unit || '公斤'
      }))
    };

    return ContentService.createTextOutput(JSON.stringify(responseData))
      .setMimeType(ContentService.MimeType.JSON)
      .setHeaders(headers);

  } catch (error) {
    Logger.log("Error in doGet: " + error.toString());
    return ContentService.createTextOutput(JSON.stringify({ error: error.message }))
      .setMimeType(ContentService.MimeType.JSON)
      .setHeaders(headers);
  }
}

/**
 * Fetches data from the Agriculture Open Data API.
 * (Task 1.2: 撰寫 GAS 爬蟲，串接農業部 API 並實作分頁抓取邏輯)
 * @returns {Array} An array of raw agricultural product data.
 */
function fetchAgricultureData() {
  Logger.log("Fetching agriculture data...");
  const allData = [];
  let page = 1;
  const pageSize = 1000; // Example page size, adjust based on API documentation

  // --- Placeholder for actual API fetching logic ---
  // Implement pagination and fetch data from AGRICULTURE_API_URL
  // Example:
  // let hasMorePages = true;
  // while (hasMorePages) {
  //   const url = `${AGRICULTURE_API_URL}?page=${page}&limit=${pageSize}`;
  //   const response = UrlFetchApp.fetch(url);
  //   const json = JSON.parse(response.getContentText());
  //   allData.push(...json.data); // Assuming 'data' field holds the array
  //   if (json.data.length < pageSize) { // Or check 'next_page' field if available
  //     hasMorePages = false;
  //   }
  //   page++;
  // }
  // Logger.log(`Fetched ${allData.length} items from agriculture API.`);

  // --- Mock data for development if API is not yet integrated ---
  const mockData = [
    {
      code: "LA1",
      name: "甘藍-改良種",
      avg_price: 25.4,
      trade_volume: 50000,
      category: "葉菜類",
      date: "2026-03-16",
      last_day_avg_price: 28.0,
      description: "新鮮甘藍，富含維生素C，是家常料理的好選擇。",
      origin: "台灣高山",
      unit: "公斤"
    },
    {
      code: "A1",
      name: "番茄-黑柿",
      avg_price: 45.0,
      trade_volume: 15000,
      category: "果菜類",
      date: "2026-03-16",
      last_day_avg_price: 42.0,
      description: "香甜多汁的黑柿番茄，適合生食或烹煮。",
      origin: "雲林",
      unit: "公斤"
    },
    {
      code: "P1",
      name: "蘋果-富士",
      avg_price: 80.0,
      trade_volume: 500,
      category: "水果",
      date: "2026-03-16",
      last_day_avg_price: 78.0,
      description: "清脆香甜的富士蘋果，老少咸宜。",
      origin: "青森",
      unit: "公斤"
    },
    {
      code: "LA2",
      name: "小白菜",
      avg_price: 15.0,
      trade_volume: 100,
      category: "葉菜類",
      date: "2026-03-16",
      last_day_avg_price: 15.5,
      description: "鮮嫩小白菜，快速烹煮即可上桌。",
      origin: "彰化",
      unit: "把"
    },
    {
      code: "RA1",
      name: "馬鈴薯",
      avg_price: 20.0,
      trade_volume: 5000,
      category: "根莖類",
      date: "2026-03-16",
      last_day_avg_price: 19.5,
      description: "鬆軟綿密的馬鈴薯，料理用途廣泛。",
      origin: "嘉義",
      unit: "公斤"
    }
  ];
  return mockData;
}

/**
 * Processes raw agriculture data.
 * (Task 1.3: 實作數據預處理：過濾掉交易量過低的品項，計算與昨日之價差 %)
 * @param {Array} rawData An array of raw agricultural product data.
 * @returns {Array} An array of processed items ready for JSON output.
 */
function processAgricultureData(rawData) {
  Logger.log("Processing agriculture data...");
  const processed = [];
  const MIN_TRADE_VOLUME = 200; // Define a minimum trade volume threshold

  rawData.forEach(item => {
    // Filter out items with low trade volume
    if (item.trade_volume < MIN_TRADE_VOLUME) {
      Logger.log(`Skipping ${item.name} due to low trade volume (${item.trade_volume}).`);
      return;
    }

    // Calculate change percentage (assuming 'last_day_avg_price' is available or can be fetched from HistoryLog)
    let change_percent = 0;
    if (item.last_day_avg_price && item.last_day_avg_price !== 0) {
      change_percent = ((item.avg_price - item.last_day_avg_price) / item.last_day_avg_price) * 100;
    }

    // Placeholder for actual trend data retrieval (from HistoryLog in Google Sheets)
    const trendData = [item.last_day_avg_price, item.avg_price]; // Simple example trend

    processed.push({
      code: item.code,
      name: item.name,
      avg_price: item.avg_price,
      change_percent: parseFloat(change_percent.toFixed(2)),
      trend: trendData,
      category: item.category,
      description: item.description || '',
      origin: item.origin || '',
      unit: item.unit || '公斤'
    });
  });

  Logger.log(`Processed ${processed.length} items.`);
  return processed;
}

/**
 * Generates an AI summary using the Gemini API.
 * (Temporarily disabled for Phase 1 - Focus on data fetching and display)
 * @param {Array} processedItems An array of processed agricultural product data.
 * @returns {string} A plain language summary for purchasing advice.
 */
function generateAiSummary(processedItems) {
  // AI functionality is disabled for Phase 1
  // Will be implemented in future phases
  Logger.log("AI summary generation is currently disabled.");
  return "";

  /* Future implementation:
  Logger.log("Generating AI summary with Gemini API...");

  const topGainers = processedItems.filter(item => item.change_percent > 0)
                                   .sort((a, b) => b.change_percent - a.change_percent)
                                   .slice(0, 3);
  const topLosers = processedItems.filter(item => item.change_percent < 0)
                                  .sort((a, b) => a.change_percent - b.change_percent)
                                  .slice(0, 3);

  let prompt = "分析今日台灣農產品價格，給予適合婆婆媽媽的白話採購建議。";
  if (topLosers.length > 0) {
    prompt += `特別指出今天價格下跌的品項，建議可以多買：${topLosers.map(item => `${item.name}跌了${Math.abs(item.change_percent)}%`).join('、')}。`;
  }
  if (topGainers.length > 0) {
    prompt += `也提醒價格上漲的品項，可能要考慮替代品：${topGainers.map(item => `${item.name}漲了${item.change_percent}%`).join('、')}。`;
  }
  prompt += "語氣要親切。";

  const payload = {
    contents: [{
      parts: [{ text: prompt }]
    }]
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    headers: {
      "x-goog-api-key": GEMINI_API_KEY
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(GEMINI_API_URL, options);
    const responseJson = JSON.parse(response.getContentText());
    return responseJson.candidates[0].content.parts[0].text;
  } catch (e) {
    Logger.log("Error calling Gemini API: " + e.toString());
    return "目前無法提供AI採購建議，請稍後再試。";
  }
  */
}

/**
 * Placeholder for doPost function (Task 4.1: For future Line Bot Webhook)
 * This function will handle POST requests, typically for webhook events.
 */
function doPost(e) {
  Logger.log("doPost received: " + JSON.stringify(e));
  // Implement Line Bot Webhook logic here in Phase 4
  return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "doPost placeholder" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// --- Helper Functions (Optional, for future use) ---

/**
 * Function to update Google Sheet (e.g., LivePrice or HistoryLog).
 * This would be part of the Crawler (Task 1.1, 1.2)
 */
function updateGoogleSheet(sheetName, data) {
  // Example:
  // var spreadsheet = SpreadsheetApp.openById(SHEET_ID);
  // var sheet = spreadsheet.getSheetByName(sheetName);
  // if (!sheet) {
  //   sheet = spreadsheet.insertSheet(sheetName);
  //   // Set headers if new sheet
  // }
  // sheet.appendRow(data);
  Logger.log(`Updating sheet '${sheetName}' with data: ${JSON.stringify(data)}`);
}

/**
 * Example function to be triggered daily (e.g., as a time-driven trigger in GAS)
 * (Part of Task 1.2 for daily updates - AI disabled for Phase 1)
 */
function dailyCrawlerUpdate() {
  Logger.log("Running daily crawler...");
  try {
    const rawData = fetchAgricultureData();
    const processedData = processAgricultureData(rawData);

    // Save processedData to LivePrice sheet
    // updateGoogleSheet("LivePrice", processedData);

    // Update HistoryLog for trend calculation
    // updateGoogleSheet("HistoryLog", processedData);

    Logger.log(`Daily update completed. Processed ${processedData.length} items.`);

  } catch (error) {
    Logger.log("Error during daily update: " + error.toString());
  }
}
