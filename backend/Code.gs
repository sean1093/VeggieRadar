/**
 * Google Apps Script (GAS) Code for VeggieRadar Project - Real-Time Search
 *
 * This script provides real-time produce price lookup by querying the
 * Taiwan Ministry of Agriculture API on demand.
 */

// --- Configuration ---
const AGRICULTURE_API_URL = "https://data.moa.gov.tw/Service/OpenData/FromM/AgriProductsTransType/";
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
    const { todayData, yesterdayData } = fetchRealTimeData(query);

    if (todayData.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({
        error: "查無此品項",
        query: query
      }))
        .setMimeType(ContentService.MimeType.JSON)
        .setHeaders(headers);
    }

    // 2. Process matched items (calculate change_percent, filter low volume)
    const processedItems = processSearchResults(todayData, yesterdayData);

    if (processedItems.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({
        error: "查無符合條件的品項（可能交易量過低）",
        query: query
      }))
        .setMimeType(ContentService.MimeType.JSON)
        .setHeaders(headers);
    }

    // 3. Construct the final JSON response
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
 * @param {string} cropName - Crop name to search for
 * @returns {Object} Object containing todayData and yesterdayData arrays
 */
function fetchRealTimeData(cropName) {
  Logger.log(`Fetching real-time agriculture data for: ${cropName}`);

  // Calculate date range (today and yesterday for price comparison)
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const todayStr = formatDateForAPI(today);
  const yesterdayStr = formatDateForAPI(yesterday);

  // Fetch today's data with crop name filter
  const todayData = fetchDataByCropName(cropName, todayStr, todayStr);
  Logger.log(`Fetched ${todayData.length} items for today (${todayStr})`);

  // Fetch yesterday's data for price comparison
  const yesterdayData = fetchDataByCropName(cropName, yesterdayStr, yesterdayStr);
  Logger.log(`Fetched ${yesterdayData.length} items for yesterday (${yesterdayStr})`);

  return { todayData, yesterdayData };
}

/**
 * Fetches data from Agriculture API for a specific crop name and date range
 * @param {string} cropName - Crop name to search for
 * @param {string} startTime - Start date in format "111.01.01" (ROC calendar)
 * @param {string} endTime - End date in format "111.01.01" (ROC calendar)
 * @returns {Array} Array of agricultural product data
 */
function fetchDataByCropName(cropName, startTime, endTime) {
  const allData = [];
  let page = null;
  let hasMoreData = true;

  // Fetch data with pagination
  while (hasMoreData) {
    // Build query parameters
    const params = {
      CropName: cropName,
      Start_time: startTime,
      End_time: endTime
    };

    // Add page parameter if exists
    if (page) {
      params.Page = page;
    }

    // Build URL with query parameters
    const url = buildURLWithParams(AGRICULTURE_API_URL, params);

    try {
      const response = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        headers: MOA_API_KEY ? { 'Authorization': `Bearer ${MOA_API_KEY}` } : {}
      });

      const result = JSON.parse(response.getContentText());

      // Check if data exists
      if (result.Data && result.Data.length > 0) {
        allData.push(...result.Data);

        // Check if there's more data
        if (result.Next === true && result.Page) {
          page = result.Page;
          Utilities.sleep(100); // Rate limiting
        } else {
          hasMoreData = false;
        }
      } else {
        hasMoreData = false;
      }

    } catch (error) {
      Logger.log(`Error fetching data for ${cropName}: ${error.toString()}`);
      hasMoreData = false;
    }
  }

  return allData;
}

/**
 * Builds a URL with query parameters
 * @param {string} baseUrl - Base URL
 * @param {Object} params - Object with query parameters
 * @returns {string} Complete URL with query string
 */
function buildURLWithParams(baseUrl, params) {
  const queryString = Object.keys(params)
    .filter(key => params[key] !== null && params[key] !== undefined)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');

  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
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
    const key = `${item.CropCode}_${item.MarketName}`;
    yesterdayPriceMap[key] = parseFloat(item.Avg_Price || 0);
  });

  todayItems.forEach(item => {
    // Parse trade volume
    const tradeVolume = parseFloat(item.Trans_Quantity || 0);

    // Filter out items with low trade volume
    if (tradeVolume < MIN_TRADE_VOLUME) {
      Logger.log(`Skipping ${item.CropName} due to low trade volume (${tradeVolume})`);
      return;
    }

    // Parse today's average price
    const avgPrice = parseFloat(item.Avg_Price || 0);
    if (avgPrice === 0) {
      return; // Skip items with no price data
    }

    // Calculate price change percentage
    const key = `${item.CropCode}_${item.MarketName}`;
    const yesterdayPrice = yesterdayPriceMap[key] || avgPrice;
    let changePercent = 0;

    if (yesterdayPrice > 0 && yesterdayPrice !== avgPrice) {
      changePercent = ((avgPrice - yesterdayPrice) / yesterdayPrice) * 100;
    }

    // Determine unit (公斤 is default)
    const unit = '公斤'; // API uses 元/公斤 for pricing

    processed.push({
      code: item.CropCode || '',
      name: item.CropName || '',
      avg_price: parseFloat(avgPrice.toFixed(1)),
      change_percent: parseFloat(changePercent.toFixed(1)),
      trade_volume: tradeVolume,
      category: item.TcType || '',
      origin: '', // Not provided in this API response
      unit: unit,
      market: item.MarketName || '',
      upper_price: parseFloat(item.Upper_Price || 0),
      middle_price: parseFloat(item.Middle_Price || 0),
      lower_price: parseFloat(item.Lower_Price || 0)
    });
  });

  Logger.log(`Processed ${processed.length} items after filtering`);
  return processed;
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
