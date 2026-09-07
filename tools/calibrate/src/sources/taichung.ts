/**
 * 臺中市公有零售市場每日蔬果價格表 — data.gov.tw 84539.
 *
 * One JSON array, ~4,400 rows, WIDE: a row is (market, survey date) and every
 * produce item is a COLUMN holding 元/台斤 as a string. `"0"` and `""` mean
 * "not surveyed at this market today", not "free", so both are dropped.
 *
 * The feed publishes 62 columns; 42 are produce and the rest are fish, meat
 * and eggs, which this product does not cover. The column names are market
 * labels, not MOA roots — `COLUMN_TO_ROOT` is the hand-checked bridge.
 */
import { cachedText } from '../http.ts';

export const TAICHUNG_URL =
  'https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=495aff49-3547-4055-aacd-f0781c6f733e';

const MARKET_KEY = '市場名稱';
const DATE_KEY = '訪價日期';

/**
 * Taichung column → MOA root, with the board item to borrow a variety filter
 * from where the retail column names one.
 *
 * Several columns share a root on purpose (four pineapple cultivars, three
 * persimmons, three pears): the runtime markup is keyed by root and applied to
 * the root's blended wholesale, so every cultivar column is evidence about the
 * same number. `item` appears only where the retail column names a variety the
 * board actually filters on (檸檬 → 雜柑-檸檬); leaving it off means "fit the
 * whole root", which is what a root with several board cards needs.
 *
 * Columns deliberately absent: the 20 fish/meat/egg columns (out of scope) and
 * 蒜苗-style produce with no board card.
 */
export const COLUMN_TO_ROOT: Record<string, { root: string; item?: string }> = {
  '絲瓜': { root: '絲瓜' },
  '花胡瓜': { root: '花胡瓜' },
  '結球白菜(山東白)': { root: '包心白菜' },
  '蘿蔔': { root: '蘿蔔' },
  '胡蘿蔔': { root: '胡蘿蔔' },
  '青蔥': { root: '青蔥', item: '蔥' },
  '胡瓜': { root: '胡瓜' },
  '青江白菜': { root: '青江白菜' },
  '蕹菜(空心菜)': { root: '蕹菜' },
  '甘藍（平地高麗菜）': { root: '甘藍' },
  '香蕉(內銷)': { root: '香蕉' },
  '番石榴(珍珠)': { root: '番石榴' },
  '鳳梨(開英)': { root: '鳳梨' },
  '荔枝(黑葉)': { root: '荔枝' },
  '火龍果(紅肉)': { root: '紅龍果' },
  '芒果(愛文)': { root: '芒果' },
  '木瓜': { root: '木瓜' },
  '文旦': { root: '柚子' },
  '新世紀梨': { root: '梨' },
  '檸檬': { root: '雜柑', item: '檸檬' },
  '鳳梨(四號)': { root: '鳳梨' },
  '火龍果(白肉)': { root: '紅龍果' },
  '新興梨': { root: '梨' },
  '橫山梨': { root: '梨' },
  '牛心柿': { root: '柿子' },
  '甜柿': { root: '柿子' },
  '紅柿(軟柿)': { root: '柿子' },
  '桶柑': { root: '桶柑' },
  '椪柑': { root: '椪柑' },
  '海梨柑': { root: '海梨柑' },
  '鳳梨(金鑽17號)': { root: '鳳梨' },
  '柳橙': { root: '甜橙' },
  '蓮霧': { root: '蓮霧' },
  '棗子': { root: '棗子' },
  '茂谷柑': { root: '茂谷柑' },
  '芒果': { root: '芒果' },
  '西瓜(大粒)': { root: '西瓜' },
  '小番茄_玉女': { root: '小番茄' },
  '小番茄_聖女': { root: '小番茄' },
  '花椰菜': { root: '花椰菜' },
  '洋蔥(內銷)': { root: '洋蔥' },
  '蒜頭': { root: '大蒜' },
};

/**
 * Columns this tool knowingly ignores — the feed's fish, meat and egg series.
 * Listed rather than pattern-matched so that a NEW produce column shows up as
 * unmapped instead of being silently dropped.
 */
export const IGNORED_COLUMNS: Record<string, true> = {
  '吳郭魚': true, '虱目魚': true, '金目鱸': true, '龍虎斑': true, '午仔魚': true,
  '白蝦': true, '文蛤': true, '里肌肉': true, '後腿肉': true, '五花肉': true,
  '牛腱(冷凍牛肉)': true, '腿肉(冷凍牛肉)': true, '腩肉(冷凍牛肉)': true,
  '雞蛋': true, '鴨蛋': true, '肉雞': true, '土雞': true, '仿雞': true,
  '鴨子(土番鴨)': true,
};

export type TaichungRow = Record<string, string>;

/** One surveyed price: an ISO date, a MOA root, and 元/台斤. */
export type RetailQuote = { date: string; root: string; item?: string; price: number };

/**
 * The whole daily feed: ~4,400 rows, one per (market, survey date).
 *
 * Completeness is checked INSIDE `accept`, before the body reaches the cache.
 * A response that is truncated mid-stream, or answered short by a struggling
 * server, is still valid-looking JSON: cached, it would freeze a thinner feed
 * into every later run and quietly shift every fitted markup. So the retry
 * decides on the parsed row count, and a body that stays short fails the run
 * instead of being written to `.cache/`.
 */
export async function fetchTaichung(): Promise<TaichungRow[]> {
  const body = await cachedText('taichung', TAICHUNG_URL, isCompleteTaichungBody);
  return JSON.parse(body) as TaichungRow[];
}

/** A year of 14 markets is ~4,400 rows; half of that is not a feed, it is an accident. */
export const TAICHUNG_MIN_ROWS = 2000;

export function isCompleteTaichungBody(body: string): boolean {
  let rows: unknown;
  try {
    rows = JSON.parse(body);
  } catch {
    return false; // truncated mid-stream
  }
  if (!Array.isArray(rows) || rows.length < TAICHUNG_MIN_ROWS) return false;
  // Every row must carry the two keys the melt joins on, or the shape changed.
  return rows.every((row) => !!row && typeof row === 'object' && DATE_KEY in row && MARKET_KEY in row);
}

/**
 * Melts the wide feed into one quote per (date, root, market).
 *
 * `unmapped` lists produce columns that are neither mapped nor knowingly
 * ignored — the feed gaining an item is a thing the operator must see, not a
 * silent drop.
 */
export function meltTaichung(rows: TaichungRow[]): { quotes: RetailQuote[]; unmapped: string[] } {
  const quotes: RetailQuote[] = [];
  const columns = new Set<string>();
  for (const row of rows) {
    const raw = String(row[DATE_KEY] ?? '');
    const date = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : '';
    if (!date) continue;
    for (const [column, value] of Object.entries(row)) {
      if (column === MARKET_KEY || column === DATE_KEY) continue;
      columns.add(column);
      const mapped = COLUMN_TO_ROOT[column];
      if (!mapped) continue;
      const price = Number(String(value ?? '').trim());
      // "0" is the feed's "not surveyed here today"; a real stall price is never 0.
      if (!Number.isFinite(price) || price <= 0) continue;
      quotes.push({ date, root: mapped.root, item: mapped.item, price });
    }
  }
  const unmapped = [...columns].filter((c) => !COLUMN_TO_ROOT[c] && !IGNORED_COLUMNS[c]).sort();
  return { quotes, unmapped };
}
