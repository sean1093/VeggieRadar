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
  return fetchPage(cropName, rocStart, rocEnd).rows;
}

/** Like `fetchCrop`, with the whole `parsePage` verdict rather than the rows. */
function fetchPage(cropName, rocStart, rocEnd) {
  if (!cropName || !rocStart) return { rows: [], answered: false, next: false };
  try {
    return parsePage(UrlFetchApp.fetch(cropUrl(cropName, rocStart, rocEnd), { muteHttpExceptions: true }));
  } catch (err) {
    Logger.log('fetchCrop error (' + cropName + ' ' + rocStart + '): ' + err);
    return { rows: [], answered: false, next: false };
  }
}

/**
 * A page's rows less its oldest date when MOA cut it short — the one date the
 * cut can have left partial, since MOA drops the oldest rows first. For a
 * caller that would rather show a day as missing than spend more requests
 * making it whole: the trend, on the public serving path.
 */
function wholeDaysOf(page) {
  if (!page.next || !page.rows.length) return page.rows;
  var oldest = null;
  for (var i = 0; i < page.rows.length; i++) {
    var day = page.rows[i].TransDate;
    if (day && (oldest === null || day < oldest)) oldest = day;
  }
  return page.rows.filter(function (r) { return r.TransDate !== oldest; });
}

/** Single-date URL when `rocEnd` is omitted; a closed range otherwise. */
function cropUrl(cropName, rocStart, rocEnd) {
  return AGRICULTURE_API_URL + '?' + [
    'CropName=' + encodeURIComponent(cropName),
    'Start_time=' + encodeURIComponent(rocStart),
    'End_time=' + encodeURIComponent(rocEnd || rocStart)
  ].join('&');
}

/**
 * A response's rows, whether MOA answered at all, and whether it cut the rows
 * short.
 *
 *   - `answered` is false for a throttled or failed request. MOA answers a
 *     burst with an EMPTY BODY, not an empty `Data`, so "nothing traded" and
 *     "nothing was said" are told apart here — a distinction every caller but
 *     the archive's backfill has so far been able to shrug off.
 *   - `next` is MOA's `Next: true`. Past roughly 1,000 rows it keeps the
 *     NEWEST and drops the oldest, so the oldest date left in a truncated
 *     response can be missing markets, and its average is then wrong rather
 *     than missing.
 */
function parsePage(resp) {
  var none = { rows: [], answered: false, next: false };
  try {
    if (resp.getResponseCode() !== 200) return none;
    var json = JSON.parse(resp.getContentText());
    // An answer is `RS: "OK"` or carries a `Data` array, even when nothing
    // traded. Anything else — an error object, a throttle — is MOA saying
    // something other than "nothing traded", and taking it for that would
    // archive the crop's absence.
    if (!json || typeof json !== 'object') return none;
    var data = Array.isArray(json.Data) ? json.Data : null;
    if (!data && json.RS !== 'OK') return none;
    return { rows: data || [], answered: true, next: json.Next === true };
  } catch (err) {
    return none;
  }
}

/**
 * Fetches rows for many root names, in small concurrent batches — on one ROC
 * date, or across a closed range when `rocEnd` is given (backfill). A single
 * 70+ request burst trips MOA's per-IP limit and comes back empty, so
 * concurrency is capped and each batch pauses briefly.
 * @param {Object=} meta optional; `meta.truncated[root]` is set for every root
 *   MOA cut short and `meta.unanswered[root]` for every root it did not
 *   answer, each cleared again by a later call that answers it whole.
 * @returns {Object} map of root → rows[]
 */
function fetchAllRows(cropNames, rocStart, rocEnd, meta) {
  var out = {};
  for (var start = 0; start < cropNames.length; start += FETCH_BATCH) {
    var slice = cropNames.slice(start, start + FETCH_BATCH);
    var requests = slice.map(function (name) {
      return { url: cropUrl(name, rocStart, rocEnd), muteHttpExceptions: true };
    });
    try {
      var responses = UrlFetchApp.fetchAll(requests);
      for (var i = 0; i < responses.length; i++) {
        var page = parsePage(responses[i]);
        out[slice[i]] = page.rows;
        if (meta) notePage(meta, slice[i], page);
      }
    } catch (err) {
      Logger.log('fetchAllRows batch error (' + rocStart + '): ' + err);
      if (meta) {
        for (var j = 0; j < slice.length; j++) notePage(meta, slice[j], { answered: false, next: false });
      }
    }
    if (start + FETCH_BATCH < cropNames.length) Utilities.sleep(120);
  }
  return out;
}

/**
 * Records what one response said about a root. An answer is never taken back:
 * `fetchRootRows` retries every root that came back empty, out-of-season ones
 * included, and a retry throttled into silence says nothing about a root that
 * already answered "nothing traded".
 */
function notePage(meta, root, page) {
  if (page.answered) {
    meta.answered[root] = true;
    delete meta.unanswered[root];
    if (page.next) {
      meta.truncated[root] = true;
    } else {
      delete meta.truncated[root];
    }
  } else if (!meta.answered[root]) {
    meta.unanswered[root] = true;
  }
}

/**
 * Like `fetchAllRows`, but retries the roots that returned nothing once. With
 * ~100 roots a throttled batch would silently drop whole rows from the board;
 * genuinely out-of-season roots just stay empty. Accepts an optional range
 * end for the backfill path.
 */
function fetchRootRows(roots, rocStart, rocEnd, meta) {
  var out = fetchAllRows(roots, rocStart, rocEnd, meta);
  var misses = roots.filter(function (r) { return !out[r] || !out[r].length; });
  if (!misses.length) return out;

  Utilities.sleep(1500);
  var retry = fetchAllRows(misses, rocStart, rocEnd, meta);
  for (var i = 0; i < misses.length; i++) {
    var root = misses[i];
    if (retry[root] && retry[root].length) out[root] = retry[root];
  }
  return out;
}

/**
 * Like `fetchRootRows` across a range, but for the long-term archive, where a
 * wrong number is worse than a missing one and a missing one is permanent: a
 * day is written once, and skipped by date ever after.
 *
 *   - A root MOA cut short is refetched in halves until every piece is whole.
 *     Halves rather than "keep what came back and fetch the rest": that would
 *     trust MOA to cut strictly by date, and a response it cut is the one
 *     thing here not to trust. A single day that still truncates cannot be
 *     made whole by splitting, so that root is left out of that day.
 *   - A root MOA did not answer, even after `fetchRootRows`' retry, is
 *     REPORTED rather than returned empty, so the caller can retry the window
 *     instead of archiving days without the crop.
 * @returns {{rows: Object, unanswered: string[], dropped: Object}} `dropped`
 *   maps a root to the days left out of it because they truncate alone.
 */
function fetchCompleteRows(roots, rocStart, rocEnd) {
  var meta = { answered: {}, truncated: {}, unanswered: {} };
  var rows = fetchRootRows(roots, rocStart, rocEnd, meta);
  var dropped = {};
  Object.keys(meta.truncated).forEach(function (root) {
    var days = [];
    var whole = fetchSplit(root, rocStart, rocEnd, days);
    if (whole === null) {
      // Not the truncated page either: its oldest day is the partial one this
      // exists to keep out, and a caller that ignores `unanswered` would use it.
      rows[root] = [];
      meta.unanswered[root] = true;
    } else {
      rows[root] = whole;
      if (days.length) dropped[root] = days;
    }
  });
  return { rows: rows, unanswered: Object.keys(meta.unanswered), dropped: dropped };
}

/**
 * Both halves of a truncated window, each fetched until it is whole, or null
 * when MOA stopped answering part-way. A day that truncates on its own is
 * left out, and pushed onto `dropped` when one is given.
 */
function fetchSplit(root, rocStart, rocEnd, dropped) {
  var from = rocToDate(rocStart);
  var span = Math.round((rocToDate(rocEnd).getTime() - from.getTime()) / 86400000) + 1;
  if (span <= 1) {
    Logger.log('fetchSplit: ' + root + ' still truncates on ' + rocStart + ' alone; left out');
    if (dropped) dropped.push(rocStart);
    return [];
  }
  var half = Math.ceil(span / 2);
  // Sequential requests right after a truncated one: keep under the per-IP limit.
  Utilities.sleep(120);
  var older = fetchWhole(root, rocStart, shiftROC(rocStart, half - 1), dropped);
  if (older === null) return null;
  Utilities.sleep(120);
  var newer = fetchWhole(root, shiftROC(rocStart, half), rocEnd, dropped);
  return newer === null ? null : older.concat(newer);
}

/**
 * One term across a range, split until MOA stops cutting it short — or null
 * when MOA did not answer. One request when nothing is cut. Not for the
 * serving path: a cut response costs sequential requests, as many as it takes.
 */
function fetchWhole(root, rocStart, rocEnd, dropped) {
  var page = fetchPage(root, rocStart, rocEnd);
  if (!page.answered) return null;
  return page.next ? fetchSplit(root, rocStart, rocEnd, dropped) : page.rows;
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

  var probe = PROBE_ROOT;
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
  return tradedVolume(fetchCrop(probe, rocDate)) >= PROBE_MIN_VOLUME;
}

/**
 * The dates on which the probe root really traded, oldest first — the
 * `isTradingDate` test applied to a range already fetched.
 */
function tradingDates(probeRows) {
  var byDate = groupByTransDate(probeRows);
  return Object.keys(byDate).filter(function (day) {
    return tradedVolume(byDate[day]) >= PROBE_MIN_VOLUME;
  }).sort();
}

/** Kilograms really traded across rows, placeholders and zero rows excluded. */
function tradedVolume(rows) {
  var traded = tradedRows(rows);
  var volume = 0;
  for (var i = 0; i < traded.length; i++) volume += parseFloat(traded[i].Trans_Quantity || 0);
  return volume;
}

/** Rows keyed by their ROC `TransDate`; a row without one is dropped. */
function groupByTransDate(rows) {
  var out = {};
  for (var i = 0; i < (rows || []).length; i++) {
    var day = rows[i].TransDate;
    if (day) (out[day] = out[day] || []).push(rows[i]);
  }
  return out;
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

function isoToROC(iso) {
  var p = iso.split('-');
  return (parseInt(p[0], 10) - 1911) + '.' + p[1] + '.' + p[2];
}

/** The ROC date `days` calendar days after `roc` (before, when negative). */
function shiftROC(roc, days) {
  var d = rocToDate(roc);
  d.setDate(d.getDate() + days);
  return dateToROC(d);
}
