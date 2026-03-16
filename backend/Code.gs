/**
 * Google Apps Script (GAS) Code for VeggieRadar Project - Real-Time Search
 *
 * This script provides real-time produce price lookup by querying the
 * Taiwan Ministry of Agriculture API on demand.
 */

// --- Configuration ---
const AGRICULTURE_API_URL = "https://data.moa.gov.tw/Service/OpenData/FromM/FarmTransData.aspx";
const MOA_API_KEY = PropertiesService.getScriptProperties().getProperty('MOA_API_KEY');

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
    // Get query parameter from request
    const query = e.parameter.query || '';

    if (!query) {
      return ContentService.createTextOutput(JSON.stringify({
        error: "請提供查詢關鍵字",
        message: "使用方式：?query=高麗菜"
      }))
        .setMimeType(ContentService.MimeType.JSON)
        .setHeaders(headers);
    }

    // 1. Fetch real-time data from Agriculture API for today and yesterday
    const { todayData, yesterdayData } = fetchRealTimeData();

    // 2. Search and filter items by query keyword
    const matchedItems = searchByKeyword(todayData, query);

    if (matchedItems.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({
        error: "查無此品項",
        query: query
      }))
        .setMimeType(ContentService.MimeType.JSON)
        .setHeaders(headers);
    }

    // 3. Process matched items (calculate change_percent, filter low volume)
    const processedItems = processSearchResults(matchedItems, yesterdayData);

    // 4. Construct the final JSON response
    const currentDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    const responseData = {
      query: query,
      date: currentDate,
      count: processedItems.length,
      items: processedItems
    };

    return ContentService.createTextOutput(JSON.stringify(responseData))
      .setMimeType(ContentService.MimeType.JSON)
      .setHeaders(headers);

  } catch (error) {
    Logger.log("Error in doGet: " + error.toString());
    return ContentService.createTextOutput(JSON.stringify({
      error: "系統錯誤",
      message: error.message
    }))
      .setMimeType(ContentService.MimeType.JSON)
      .setHeaders(headers);
  }
}

/**
 * Fetches real-time data from Agriculture API for today and yesterday
 * @returns {Object} Object containing todayData and yesterdayData arrays
 */
function fetchRealTimeData() {
  Logger.log("Fetching real-time agriculture data...");

  // Calculate date range (today and yesterday for price comparison)
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const todayStr = formatDateForAPI(today);
  const yesterdayStr = formatDateForAPI(yesterday);

  // Fetch today's data
  const todayData = fetchDataByDate(todayStr, todayStr);
  Logger.log(`Fetched ${todayData.length} items for today (${todayStr})`);

  // Fetch yesterday's data for price comparison
  const yesterdayData = fetchDataByDate(yesterdayStr, yesterdayStr);
  Logger.log(`Fetched ${yesterdayData.length} items for yesterday (${yesterdayStr})`);

  return { todayData, yesterdayData };
}

/**
 * Fetches data from Agriculture API for a specific date range
 * @param {string} startDate - Start date in format "111.01.01" (ROC calendar)
 * @param {string} endDate - End date in format "111.01.01" (ROC calendar)
 * @returns {Array} Array of agricultural product data
 */
function fetchDataByDate(startDate, endDate) {
  const allData = [];
  const pageSize = 1000;
  let skip = 0;
  let hasMoreData = true;

  // Fetch data with pagination
  while (hasMoreData) {
    const url = `${AGRICULTURE_API_URL}?StartDate=${startDate}&EndDate=${endDate}&$top=${pageSize}&$skip=${skip}`;

    try {
      const response = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        headers: MOA_API_KEY ? { 'Authorization': `Bearer ${MOA_API_KEY}` } : {}
      });

      const data = JSON.parse(response.getContentText());

      if (data && data.length > 0) {
        allData.push(...data);
        skip += pageSize;

        // If we got less than pageSize, we've reached the end
        if (data.length < pageSize) {
          hasMoreData = false;
        }
      } else {
        hasMoreData = false;
      }

      // Avoid hitting rate limits
      Utilities.sleep(100);

    } catch (error) {
      Logger.log(`Error fetching data for ${startDate}: ${error.toString()}`);
      hasMoreData = false;
    }
  }

  return allData;
}

/**
 * Formats a Date object to ROC calendar format for API (e.g., "115.03.16")
 * @param {Date} date - JavaScript Date object
 * @returns {string} Date string in ROC calendar format
 */
function formatDateForAPI(date) {
  const year = date.getFullYear() - 1911; // Convert to ROC year
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}.${month}.${day}`;
}

/**
 * Searches for items matching the query keyword
 * @param {Array} data - Array of agricultural product data
 * @param {string} query - Search keyword
 * @returns {Array} Filtered array of matching items
 */
function searchByKeyword(data, query) {
  Logger.log(`Searching for keyword: ${query}`);

  // Normalize query (remove spaces, convert to lowercase)
  const normalizedQuery = query.toLowerCase().trim();

  const matchedItems = data.filter(item => {
    const itemName = (item.作物名稱 || '').toLowerCase();

    // Check if item name contains the query keyword
    return itemName.includes(normalizedQuery);
  });

  Logger.log(`Found ${matchedItems.length} items matching "${query}"`);
  return matchedItems;
}

/**
 * Processes search results: calculate price changes, filter low volume
 * @param {Array} todayItems - Today's matched items
 * @param {Array} yesterdayData - Yesterday's full data for comparison
 * @returns {Array} Processed items ready for response
 */
function processSearchResults(todayItems, yesterdayData) {
  Logger.log("Processing search results...");
  const processed = [];
  const MIN_TRADE_VOLUME = 200; // Minimum trade volume threshold

  // Create a map of yesterday's prices by crop code and market
  const yesterdayPriceMap = {};
  yesterdayData.forEach(item => {
    const key = `${item.作物代號}_${item.市場名稱}`;
    yesterdayPriceMap[key] = parseFloat(item.平均價 || 0);
  });

  todayItems.forEach(item => {
    // Parse trade volume
    const tradeVolume = parseFloat(item.交易量 || 0);

    // Filter out items with low trade volume
    if (tradeVolume < MIN_TRADE_VOLUME) {
      Logger.log(`Skipping ${item.作物名稱} due to low trade volume (${tradeVolume})`);
      return;
    }

    // Parse today's average price
    const avgPrice = parseFloat(item.平均價 || 0);
    if (avgPrice === 0) {
      return; // Skip items with no price data
    }

    // Calculate price change percentage
    const key = `${item.作物代號}_${item.市場名稱}`;
    const yesterdayPrice = yesterdayPriceMap[key] || avgPrice;
    let changePercent = 0;

    if (yesterdayPrice > 0 && yesterdayPrice !== avgPrice) {
      changePercent = ((avgPrice - yesterdayPrice) / yesterdayPrice) * 100;
    }

    // Extract origin information (if available in 上價 or 中價 fields)
    const origin = item.產地 || extractOriginFromFields(item) || '';

    processed.push({
      code: item.作物代號 || '',
      name: item.作物名稱 || '',
      avg_price: parseFloat(avgPrice.toFixed(1)),
      change_percent: parseFloat(changePercent.toFixed(1)),
      trade_volume: tradeVolume,
      category: item.種類名稱 || '',
      origin: origin,
      unit: item.交易單位 || '公斤',
      market: item.市場名稱 || ''
    });
  });

  Logger.log(`Processed ${processed.length} items after filtering`);
  return processed;
}

/**
 * Attempts to extract origin information from price fields
 * @param {Object} item - API data item
 * @returns {string} Origin or empty string
 */
function extractOriginFromFields(item) {
  // Some API responses may include origin info in specific fields
  // This is a placeholder - adjust based on actual API response structure
  return '';
}

/**
 * Placeholder for doPost function (for future Line Bot Webhook)
 */
function doPost(e) {
  Logger.log("doPost received: " + JSON.stringify(e));
  return ContentService.createTextOutput(JSON.stringify({
    status: "success",
    message: "doPost placeholder"
  }))
    .setMimeType(ContentService.MimeType.JSON);
}
