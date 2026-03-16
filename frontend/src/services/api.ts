/**
 * API Service for VeggieRadar
 * Handles communication with Google Apps Script backend
 */

import type { ApiResponse } from '../types/produce';

// GAS API endpoint
const API_BASE_URL = 'https://script.google.com/macros/s/AKfycbxdcRsDTbEfDbSV8ev3vfC0z1E2k7OA1NnFmq0nQv7FO6DH18_9pkcxwwou1Iwn6E6_/exec';

/**
 * Search for produce items by name
 * @param query - The produce name to search for (e.g., "番茄", "高麗菜")
 * @returns Promise with API response
 */
export async function searchProduce(query: string): Promise<ApiResponse> {
  if (!query || query.trim().length === 0) {
    return {
      error: '請輸入查詢關鍵字',
      query: query,
    };
  }

  try {
    const url = `${API_BASE_URL}?query=${encodeURIComponent(query.trim())}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data: ApiResponse = await response.json();
    return data;

  } catch (error) {
    console.error('API Error:', error);
    return {
      error: '系統錯誤，請稍後再試',
      message: error instanceof Error ? error.message : 'Unknown error',
      query: query,
    };
  }
}
