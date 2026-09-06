/**
 * The plausibility guard: whether a freshly built board may replace the one
 * users are looking at, and which of its items cannot be trusted today.
 */


// --- Plausibility guard ---
//
// `refreshBoardCache` used to reject exactly one thing: an empty board.
// Everything else was stored, so the two failure modes MOA actually produces —
// a throttled crawl where only some roots answer, and a unit or column change
// where every price shifts at once — overwrote a good board with a wrong one,
// and `updateHistory` baked the wrong numbers into the 28-day baseline on the
// way.
//
// The rules describe what a BROKEN CRAWL looks like, not what an unusual
// market looks like. Nothing here corrects data: a board is published as
// crawled or not published at all, because deciding which of two numbers is
// the real one is guessing, and a price board that guesses has nothing left to
// offer. Item-level findings therefore only MARK the item — withholding 93
// good prices over one bad transaction would be the worse trade.

/**
 * Judges a freshly built board against the stored one.
 *
 * @param {Object} next board from `buildBoard`.
 * @param {Object|null} prev the stored board, parsed. Null on first deploy —
 *   then only the absolute floor can fire, since every other rule compares.
 * @returns {{ok: boolean, reasons: string[], suspects: string[]}} `reasons`
 *   lists EVERY triggered board-level rule in English (it travels to `diag`
 *   and into the failure mail); `suspects` holds item display names.
 */
function validateBoard(next, prev) {
  var items = (next && next.items) || [];
  var prevItems = (prev && prev.items) || [];
  // The item array is what counts; `count` is a derived duplicate that a torn
  // or hand-written payload can disagree with.
  var count = items.length;
  var reasons = [];

  // (a) Too few items. The floor answers "the crawl failed"; the relative bound
  // catches a partial crawl on a day that plainly had more data than this.
  var minCount = BOARD_MIN_ITEMS;
  var relative = BOARD_MIN_PREV_RATIO * prevItems.length;
  if (relative > minCount) minCount = relative;
  if (count < minCount) {
    reasons.push(count < BOARD_MIN_ITEMS
      ? 'count ' + count + ' < floor ' + BOARD_MIN_ITEMS
      : 'count ' + count + ' < ' + Math.round(BOARD_MIN_PREV_RATIO * 100) + '% of previous ' + prevItems.length);
  }

  // Rules (b) and (c) compare prices item by item, so they need items present
  // in BOTH boards — a crop that just left or joined the board says nothing
  // about the feed. With no overlap at all there is nothing to compare and both
  // rules stay silent.
  var prevByName = {};
  for (var p = 0; p < prevItems.length; p++) prevByName[prevItems[p].name] = prevItems[p];
  var ratios = [];
  for (var i = 0; i < items.length; i++) {
    var was = prevByName[items[i].name];
    if (!was || !(was.catty_price > 0) || !(items[i].catty_price > 0)) continue;
    ratios.push(items[i].catty_price / was.catty_price);
  }

  if (ratios.length) {
    // (b) Many items jumping at once is the signature of a unit or column
    // change: real markets move a handful of crops, never a fifth of the board
    // by a factor of three.
    var jumped = 0;
    for (var j = 0; j < ratios.length; j++) {
      if (ratios[j] > BOARD_JUMP_RATIO || ratios[j] < 1 / BOARD_JUMP_RATIO) jumped++;
    }
    var share = jumped / ratios.length;
    if (share >= BOARD_MAX_JUMP_SHARE) {
      reasons.push(jumped + ' of ' + ratios.length + ' common items moved by more than ' +
        Math.round((BOARD_JUMP_RATIO - 1) * 100) + '% (' + Math.round(share * 100) + '%, limit ' +
        Math.round(BOARD_MAX_JUMP_SHARE * 100) + '%)');
    }

    // (c) The median moving is the whole board being displaced — the same
    // change applied to every price, which no trading day does.
    var mid = median(ratios);
    if (mid < BOARD_SHIFT_MIN_RATIO || mid > BOARD_SHIFT_MAX_RATIO) {
      reasons.push('median price ratio ' + round1(mid) + ' over ' + ratios.length +
        ' common items outside [' + BOARD_SHIFT_MIN_RATIO + ', ' + BOARD_SHIFT_MAX_RATIO + ']');
    }
  }

  // (d) The trading date going backwards means the date probe picked the wrong
  // day, which makes every `change_percent` on the board wrong too. Comparing
  // ROC date strings lexicographically is safe — see `rocDateDaysAgo`.
  if (next && prev && next.roc_date && prev.roc_date && next.roc_date < prev.roc_date) {
    reasons.push('trading date ' + next.roc_date + ' is older than the stored ' + prev.roc_date);
  }

  var suspects = [];
  for (var k = 0; k < items.length; k++) {
    var it = items[k];
    var before = prevByName[it.name];
    var suspect = false;

    // (e) A huge move on collapsed volume is one outlier transaction carrying
    // the whole average, not a price. The issue proposed comparing against the
    // item's HISTORY median volume, but the history store keeps prices only
    // (`[[roc, price], ...]`); the previous board already carries yesterday's
    // volume, so it is used instead — adding volume to the store would change
    // its format for a signal we already have.
    if (Math.abs(it.change_percent || 0) > SUSPECT_CHANGE_PERCENT &&
      before && before.trade_volume > 0 &&
      it.trade_volume < SUSPECT_VOLUME_RATIO * before.trade_volume) {
      suspect = true;
    }

    // (f) One variety holding nearly all the volume IS the item, so its price
    // must agree with the item's; a wide gap means rows from another crop were
    // grouped in. Today's `varietyBreakdown` cannot emit this shape — it
    // publishes at least two varieties, each ≥ 10 % of volume — so this guards
    // against a future publisher change rather than anything observed.
    var varieties = it.varieties || [];
    for (var v = 0; v < varieties.length; v++) {
      if (!(varieties[v].share_percent > SUSPECT_VARIETY_SHARE) || !(it.catty_price > 0)) continue;
      if (Math.abs(varieties[v].catty_price - it.catty_price) / it.catty_price > SUSPECT_VARIETY_DIVERGENCE) {
        suspect = true;
      }
    }

    if (suspect && suspects.indexOf(it.name) === -1) suspects.push(it.name);
  }

  return { ok: reasons.length === 0, reasons: reasons, suspects: suspects };
}

/**
 * Marks the named items `suspect` in place. The flag rides along on the stored
 * board: `updateHistory` skips those items, and the frontend hides their change
 * and baseline badges while still showing the price.
 */
function markSuspects(board, names) {
  if (!board || !board.items || !names || !names.length) return board;
  var flagged = {};
  for (var i = 0; i < names.length; i++) flagged[names[i]] = true;
  for (var j = 0; j < board.items.length; j++) {
    if (flagged[board.items[j].name]) board.items[j].suspect = true;
  }
  return board;
}
