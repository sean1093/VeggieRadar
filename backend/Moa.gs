/**
 * MOA open-data access and row filtering: fetching, batching, the
 * trading-date probe, and the substring/placeholder defences the feed demands.
 */


// --- MOA API access ---

/**
 * Fetches all rows for a crop-name term on a ROC date, or across a closed
 * date range when `rocEnd` is given. MOA matches the term anywhere inside
 * `CropName`, so the result is a superset of the wanted root — callers must
 * filter with `selectRows` / `rowRoot`.
 */
function fetchCrop(cropName, rocStart, rocEnd) {
  if (!cropName || !rocStart) return [];
  try {
    var resp = UrlFetchApp.fetch(cropUrl(cropName, rocStart, rocEnd), { muteHttpExceptions: true });
    return parseRows(resp);
  } catch (err) {
    Logger.log('fetchCrop error (' + cropName + ' ' + rocStart + '): ' + err);
    return [];
  }
}

/** Single-date URL when `rocEnd` is omitted; a closed range otherwise. */
function cropUrl(cropName, rocStart, rocEnd) {
  return AGRICULTURE_API_URL + '?' + [
    'CropName=' + encodeURIComponent(cropName),
    'Start_time=' + encodeURIComponent(rocStart),
    'End_time=' + encodeURIComponent(rocEnd || rocStart)
  ].join('&');
}

/** Parses MOA rows from a single HTTPResponse. */
function parseRows(resp) {
  try {
    if (resp.getResponseCode() !== 200) return [];
    var json = JSON.parse(resp.getContentText());
    return (json && json.Data) ? json.Data : [];
  } catch (err) {
    return [];
  }
}

/**
 * Fetches rows for many root names, in small concurrent batches — on one ROC
 * date, or across a closed range when `rocEnd` is given (backfill). A single
 * 70+ request burst trips MOA's per-IP limit and comes back empty, so
 * concurrency is capped and each batch pauses briefly.
 * @returns {Object} map of root → rows[]
 */
function fetchAllRows(cropNames, rocStart, rocEnd) {
  var out = {};
  for (var start = 0; start < cropNames.length; start += FETCH_BATCH) {
    var slice = cropNames.slice(start, start + FETCH_BATCH);
    var requests = slice.map(function (name) {
      return { url: cropUrl(name, rocStart, rocEnd), muteHttpExceptions: true };
    });
    try {
      var responses = UrlFetchApp.fetchAll(requests);
      for (var i = 0; i < responses.length; i++) {
        out[slice[i]] = parseRows(responses[i]);
      }
    } catch (err) {
      Logger.log('fetchAllRows batch error (' + rocStart + '): ' + err);
    }
    if (start + FETCH_BATCH < cropNames.length) Utilities.sleep(120);
  }
  return out;
}

/**
 * Like `fetchAllRows`, but retries the roots that returned nothing once. With
 * ~100 roots a throttled batch would silently drop whole rows from the board;
 * genuinely out-of-season roots just stay empty. Accepts an optional range
 * end for the backfill path.
 */
function fetchRootRows(roots, rocStart, rocEnd) {
  var out = fetchAllRows(roots, rocStart, rocEnd);
  var misses = roots.filter(function (r) { return !out[r] || !out[r].length; });
  if (!misses.length) return out;

  Utilities.sleep(1500);
  var retry = fetchAllRows(misses, rocStart, rocEnd);
  for (var i = 0; i < misses.length; i++) {
    var root = misses[i];
    if (retry[root] && retry[root].length) out[root] = retry[root];
  }
  return out;
}

/**
 * Finds the latest ROC date with real trades and the previous such date.
 * Probing costs up to 16 fetches, so the result is shared through the cache
 * for an hour — that is what keeps a burst of search misses cheap. The board
 * build passes `fresh`: its correctness must never ride on a stale probe, and
 * its fresh answer re-primes the cache for the search path.
 */
function resolveTradeDates(fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    var hit = cache.get(TRADE_DATES_CACHE_KEY);
    if (hit) return JSON.parse(hit);
  }

  var probe = '甘藍'; // cabbage: year-round, all markets, high volume — the most reliable probe
  var today = new Date();
  var latest = null;
  var prev = null;

  for (var i = 0; i < MAX_LOOKBACK_DAYS && !latest; i++) {
    var d = new Date(today);
    d.setDate(today.getDate() - i);
    var roc = dateToROC(d);
    if (isTradingDate(probe, roc)) latest = roc;
  }
  if (!latest) return { latest: null, prev: null }; // never cache a failed probe

  var latestDate = rocToDate(latest);
  for (var j = 1; j <= MAX_LOOKBACK_DAYS && !prev; j++) {
    var pd = new Date(latestDate);
    pd.setDate(latestDate.getDate() - j);
    var proc = dateToROC(pd);
    if (isTradingDate(probe, proc)) prev = proc;
  }

  var dates = { latest: latest, prev: prev };
  cache.put(TRADE_DATES_CACHE_KEY, JSON.stringify(dates), TRADE_DATES_TTL);
  return dates;
}

/**
 * True when the probe crop really traded island-wide on this date. MOA returns
 * `休市` placeholder rows with zero price/quantity for closed markets — and for
 * today, before the closing prices publish — so row count alone is not enough:
 * it would pick a date on which every board item aggregates to nothing.
 */
function isTradingDate(probe, rocDate) {
  var rows = tradedRows(fetchCrop(probe, rocDate));
  var volume = 0;
  for (var i = 0; i < rows.length; i++) {
    volume += parseFloat(rows[i].Trans_Quantity || 0);
  }
  return volume >= PROBE_MIN_VOLUME;
}

// --- Row filtering ---

/** MOA `CropName` is `<root>` or `<root>-<variety>`. */
function rowRoot(cropName) {
  if (!cropName) return '';
  var i = cropName.indexOf('-');
  return i === -1 ? cropName : cropName.substring(0, i);
}

function rowVariety(cropName) {
  if (!cropName) return '';
  var i = cropName.indexOf('-');
  return i === -1 ? '' : cropName.substring(i + 1);
}

/** Drops `休市` placeholders and any row without a real price and quantity. */
function tradedRows(rows) {
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (!r || !r.CropName || r.CropName === '休市') continue;
    if (!(parseFloat(r.Avg_Price || 0) > 0) || !(parseFloat(r.Trans_Quantity || 0) > 0)) continue;
    out.push(r);
  }
  return out;
}

/**
 * Keeps only the rows a board item actually wants: exact root match plus the
 * optional variety include/exclude. Without this, `蔥` picks up 洋蔥, `蘿蔔`
 * picks up 胡蘿蔔, `胡瓜` picks up 花胡瓜 and `薑` picks up 薑荷花.
 */
function selectRows(rows, def) {
  var out = [];
  var candidates = tradedRows(rows);
  for (var i = 0; i < candidates.length; i++) {
    var r = candidates[i];
    if (rowRoot(r.CropName) !== def.official) continue;
    var variety = rowVariety(r.CropName);
    if (def.variety && variety.indexOf(def.variety) === -1) continue;
    if (def.excludes && containsAny(variety, def.excludes)) continue;
    out.push(r);
  }
  return out;
}

function containsAny(text, needles) {
  for (var i = 0; i < needles.length; i++) {
    if (text.indexOf(needles[i]) !== -1) return true;
  }
  return false;
}

// --- Date helpers (ROC calendar) ---

function dateToROC(d) {
  var y = d.getFullYear() - 1911;
  var m = ('0' + (d.getMonth() + 1)).slice(-2);
  var day = ('0' + d.getDate()).slice(-2);
  return y + '.' + m + '.' + day;
}

function rocToDate(roc) {
  var p = roc.split('.');
  return new Date(parseInt(p[0], 10) + 1911, parseInt(p[1], 10) - 1, parseInt(p[2], 10));
}

function rocToISO(roc) {
  var p = roc.split('.');
  var y = parseInt(p[0], 10) + 1911;
  return y + '-' + p[1] + '-' + p[2];
}
