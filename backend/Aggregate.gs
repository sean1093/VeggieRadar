/**
 * Turning filtered MOA rows into one board card: volume-weighted
 * prices, the estimated retail band, and the per-variety breakdown.
 */


// --- Aggregation ---

/**
 * Aggregates already-filtered MOA rows into one board card.
 * Price = volume-weighted average of Avg_Price; change vs the previous date.
 */
function aggregateGroup(def, todayRows, prevRows) {
  var today = weightedAverage(todayRows);
  if (today.volume < MIN_TRADE_VOLUME || today.avg <= 0) return null;

  var changePercent = 0;
  if (prevRows && prevRows.length) {
    var prev = weightedAverage(prevRows);
    if (prev.avg > 0) {
      changePercent = ((today.avg - prev.avg) / prev.avg) * 100;
    }
  }

  var cattyPrice = today.avg * CATTY_PER_KG;
  var retail = retailBand(cattyPrice, def.official, def.category);

  var card = {
    code: (todayRows[0] && todayRows[0].CropCode) || def.official,
    name: def.name,
    official_name: def.official,
    category: def.category,
    avg_price: round1(today.avg),
    catty_price: round1(cattyPrice),
    retail_low: retail.low,
    retail_price: retail.mid,
    retail_high: retail.high,
    retail_estimated: true,
    change_percent: round1(changePercent),
    trade_volume: Math.round(today.volume),
    unit: '公斤',
    markets_count: today.markets
  };

  // A blended average can sit far from every stall when varieties diverge
  // (綠竹筍 trades at 2.5× 麻竹筍). The drawer decomposes it when that happens.
  var varieties = varietyBreakdown(def, todayRows, today.volume);
  if (varieties) card.varieties = varieties;
  return card;
}

/**
 * Per-variety summary for one board item, or null when a breakdown would add
 * nothing (fewer than two meaningful varieties). Shares are computed against
 * the item's TOTAL traded volume, so they stay honest even when folded-away
 * small varieties leave the shown rows summing below 100%.
 *
 * Each row carries BOTH bases, matching the card: the estimated market price
 * leads and the measured wholesale price supports it. Publishing wholesale
 * alone made the section unusable — a shopper is quoted retail, so a
 * wholesale-only row cannot be compared with anything at the stall, and it
 * silently disagreed with the card's retail headline.
 *
 * Applying the ROOT markup to a variety is sound precisely because the markup
 * is ADDITIVE and constant per crop:
 *
 *   retail_variety = wholesale_variety + markup(root)
 *   retail_blend   = wholesale_blend   + markup(root) = Σ(share × retail_variety)
 *
 * So the markup's error is identical for both, while the variety row uses a
 * more precise wholesale input — making it MORE accurate for the variety in
 * front of the shopper than the headline is. It also makes the card's
 * headline exactly the volume-weighted average of these rows, which is what
 * the drawer now says out loud.
 */
function varietyBreakdown(def, rows, totalVolume) {
  if (!(totalVolume > 0)) return null;
  var groups = {};
  for (var i = 0; i < rows.length; i++) {
    var name = rowVariety(rows[i].CropName) || '一般';
    (groups[name] = groups[name] || []).push(rows[i]);
  }
  var names = Object.keys(groups);
  if (names.length < 2) return null;

  var qualified = [];
  for (var j = 0; j < names.length; j++) {
    var g = weightedAverage(groups[names[j]]);
    if (g.volume < MIN_TRADE_VOLUME) continue;
    var share = g.volume / totalVolume;
    if (share < VARIETY_MIN_SHARE) continue;
    var catty = g.avg * CATTY_PER_KG;
    qualified.push({
      name: names[j],
      catty_price: round1(catty),
      // Same calibrated table and same rounding as the card's headline, so the
      // two surfaces cannot drift apart.
      retail_price: retailBand(catty, def.official, def.category).mid,
      share_percent: Math.round(share * 100),
      volume: g.volume
    });
  }
  if (qualified.length < 2) return null;

  qualified.sort(function (a, b) { return b.volume - a.volume; });
  return qualified.slice(0, VARIETY_MAX_COUNT).map(function (v) {
    return {
      name: v.name,
      catty_price: v.catty_price,
      retail_price: v.retail_price,
      share_percent: v.share_percent
    };
  });
}

/**
 * Estimated traditional-market retail band in 元/台斤. Rounded outward to the
 * nearest NT$5 because stalls price in round numbers, and because implying
 * single-digit precision on an estimate would be dishonest.
 */
function retailBand(cattyPrice, root, category) {
  var markup = RETAIL_MARKUP_ROOT[root];
  var low, mid, high;
  if (markup) {
    low = markup * RETAIL_BAND_LOW;
    mid = markup;
    high = markup * RETAIL_BAND_HIGH;
  } else {
    var band = RETAIL_MARKUP_CATEGORY[category] || RETAIL_MARKUP_CATEGORY['其他'];
    low = band[0];
    mid = band[1];
    high = band[2];
  }
  return {
    low: floorTo5(cattyPrice + low),
    mid: Math.round(cattyPrice + mid),
    high: ceilTo5(cattyPrice + high)
  };
}

function floorTo5(n) {
  return Math.max(5, Math.floor(n / 5) * 5);
}

function ceilTo5(n) {
  return Math.ceil(n / 5) * 5;
}

/** Volume-weighted average price across rows. */
function weightedAverage(rows) {
  var priceQty = 0, totalQty = 0, markets = {};
  for (var i = 0; i < rows.length; i++) {
    var price = parseFloat(rows[i].Avg_Price || 0);
    var qty = parseFloat(rows[i].Trans_Quantity || 0);
    if (price > 0 && qty > 0) {
      priceQty += price * qty;
      totalQty += qty;
      markets[rows[i].MarketName] = true;
    }
  }
  return {
    avg: totalQty > 0 ? priceQty / totalQty : 0,
    volume: totalQty,
    markets: Object.keys(markets).length
  };
}

/** Best-effort category for a MOA root that is not on the board. */
function categoryOf(root) {
  for (var i = 0; i < BOARD_ITEMS.length; i++) {
    if (BOARD_ITEMS[i].official === root) return BOARD_ITEMS[i].category;
  }
  if (/菇|菌|木耳/.test(root)) return '菇類';
  if (/瓜/.test(root)) return '瓜果類';
  if (/柑|橙|柚|梨|桃|李|莓|蕉|果|棗|柿|葡萄|釋迦|蓮霧/.test(root)) return '水果';
  if (/菜|蔥|韭|芹|萵|蒿|莧/.test(root)) return '葉菜類';
  if (/薯|芋|筍|藕|蔔|蒡/.test(root)) return '根莖類';
  return '其他';
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
