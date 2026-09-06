/**
 * 臺北市公有零售市場行情 — data.taipei dataset 54d9d492-…
 *
 * Monthly, not daily: the dataset is a LIST of one resource per month, each
 * with ~122 items priced in 元/台斤. Eighteen months of history is what makes
 * tier 2 possible at all.
 *
 * data.taipei has no metadata endpoint that names a resource's month — the
 * only place the two appear together is the rendered dataset page. So the
 * month map is scraped, checked against a committed fixture, and the fixture
 * is what the tests and a broken-page day run on.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedText } from '../http.ts';
import type { RetailQuote } from './taichung.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = resolve(HERE, '../../fixtures/taipei-resources.json');

export const DATASET_ID = '54d9d492-1e2e-40d1-ae7b-fbce6f271bf1';
export const DATASET_PAGE = `https://data.taipei/dataset/detail?id=${DATASET_ID}`;

/** Below this the page has clearly changed shape and the scrape must not be trusted. */
export const MIN_RESOURCES = 12;

/** How far from a UUID a `NNN年M月` label may sit and still describe it. */
const LABEL_WINDOW = 400;

const ITEM_KEY = '項目';
const PRICE_KEY = '平均（元/台斤）';

export type MonthlyResource = { month: string; rid: string };

/**
 * Taipei item → MOA root, with the board item to borrow a variety filter from
 * where the retail row names one.
 *
 * Cultivar rows collapse onto one root deliberately (three mangoes, three
 * pears, three watermelons): the runtime markup is keyed by root. `item` is
 * set only where the retail row names a variety the board filters, so that the
 * fit sees the same wholesale the card will:
 *   - 檸檬 → 雜柑-檸檬 (the root also carries 金桔)
 *   - 甜椒(青椒) → the 青椒 card (coloured bell peppers trade far higher)
 *   - 甜玉米 → the 玉米 card, which excludes 玉米筍
 *
 * Dropped on purpose, with the reason:
 *   - 20 fish rows, 3 pork/poultry rows, 3 egg/duck rows — out of scope.
 *   - 青蒜 (garlic scapes), 甘藍芽 (cabbage sprouts), 金針菜(乾) (dried daylily),
 *     香菇(太空包)乾 (DRIED shiitake — the board's root 濕香菇 is the wet one):
 *     no board card, or a different product from the card that shares its name.
 */
export const ITEM_TO_ROOT: Record<string, { root: string; item?: string }> = {
  '蘿蔔': { root: '蘿蔔' },
  '胡蘿蔔': { root: '胡蘿蔔' },
  '牛蒡': { root: '牛蒡' },
  '生薑(嫩薑)': { root: '薑' },
  '芋頭': { root: '芋' },
  '綠竹筍': { root: '竹筍' },
  '麻竹筍': { root: '竹筍' },
  '綠蘆筍': { root: '蘆筍' },
  '茭白筍(帶殼)': { root: '茭白筍' },
  '大芥菜': { root: '芥菜' },
  '馬鈴薯': { root: '馬鈴薯' },
  '青蔥': { root: '青蔥', item: '蔥' },
  '洋蔥(內銷)': { root: '洋蔥' },
  '蒜頭': { root: '大蒜' },
  '韭菜': { root: '韭菜' },
  '蕹菜(空心菜)': { root: '蕹菜' },
  '芹菜(土芹菜)': { root: '芹菜' },
  '甘藍': { root: '甘藍' },
  '小白菜': { root: '小白菜' },
  '青江白菜': { root: '青江白菜' },
  '結球白菜': { root: '包心白菜' },
  '菠菜': { root: '菠菜' },
  '芥藍': { root: '芥藍菜' },
  '莧菜': { root: '莧菜' },
  '萵苣(油麥菜)': { root: '萵苣菜' },
  '本島萵苣': { root: '萵苣菜' },
  '茼萵': { root: '茼蒿' },
  '花椰菜': { root: '花椰菜' },
  '青花苔': { root: '花椰菜' },
  '胡瓜': { root: '胡瓜' },
  '花胡瓜': { root: '花胡瓜' },
  '冬瓜': { root: '冬瓜' },
  '苦瓜': { root: '苦瓜' },
  '絲瓜': { root: '絲瓜' },
  '扁蒲': { root: '扁蒲' },
  '茄子': { root: '茄子' },
  '番茄': { root: '番茄' },
  '甜椒(青椒)': { root: '甜椒', item: '青椒' },
  '敏豆(四季豆)': { root: '敏豆' },
  '豇豆': { root: '菜豆' },
  '豌豆': { root: '豌豆' },
  '甜豌豆': { root: '豌豆' },
  '甜玉米': { root: '玉米', item: '玉米' },
  '香菇(太空包)鮮': { root: '濕香菇' },
  '木耳(黑色溼)': { root: '濕木耳' },
  '西瓜(大粒)': { root: '西瓜' },
  '西瓜(小粒)': { root: '西瓜' },
  '西瓜(無子)': { root: '西瓜' },
  '洋香瓜(秋蜜)': { root: '洋香瓜' },
  '香瓜(美濃瓜)': { root: '甜瓜' },
  '芒果(在來)': { root: '芒果' },
  '芒果(愛文)': { root: '芒果' },
  '芒果(金煌)': { root: '芒果' },
  '番石榴(世紀)': { root: '番石榴' },
  '番石榴(珍珠)': { root: '番石榴' },
  '蓮霧': { root: '蓮霧' },
  '枇杷': { root: '枇杷' },
  '荔枝(黑葉)': { root: '荔枝' },
  '荔枝(玉荷)': { root: '荔枝' },
  '龍眼(大粒)': { root: '龍眼' },
  '棗子': { root: '棗子' },
  '番荔枝(釋迦)': { root: '釋迦' },
  '楊桃': { root: '楊桃' },
  '木瓜': { root: '木瓜' },
  '香蕉(內銷)': { root: '香蕉' },
  '鳳梨(開英)': { root: '鳳梨' },
  '鳳梨(17號)': { root: '鳳梨' },
  '椪柑': { root: '椪柑' },
  '桶柑': { root: '桶柑' },
  '文旦': { root: '柚子' },
  '白柚': { root: '柚子' },
  '柳橙': { root: '甜橙' },
  '檸檬': { root: '雜柑', item: '檸檬' },
  '海梨柑': { root: '海梨柑' },
  '茂谷柑': { root: '茂谷柑' },
  '李(玉李)': { root: '李' },
  '李(紅肉)': { root: '李' },
  '鶯歌桃': { root: '桃子' },
  '甜桃': { root: '桃子' },
  '水蜜桃': { root: '桃子' },
  '牛心柿': { root: '柿子' },
  '甜柿': { root: '柿子' },
  '紅柿(軟柿)': { root: '柿子' },
  '橫山梨': { root: '梨' },
  '新世紀梨': { root: '梨' },
  '新興梨': { root: '梨' },
  '巨峰葡萄': { root: '葡萄' },
  '火龍果': { root: '紅龍果' },
  '小番茄(玉女)': { root: '小番茄' },
  '小番茄(聖女)': { root: '小番茄' },
};

/** Items knowingly out of scope, so a NEW produce row still surfaces. */
export const IGNORED_ITEMS: Record<string, true> = {
  '虱目魚': true, '吳郭魚': true, '大頭鰱': true, '赤宗': true, '加臘': true,
  '盤仔': true, '白鯧': true, '旗魚': true, '鮪魚': true, '肉魚': true,
  '紅目鰱': true, '透抽': true, '白帶魚': true, '鯖魚': true, '白口': true,
  '秋刀': true, '海鰻': true, '金線魚': true, '草蝦': true, '紅蝦': true,
  '里肌肉': true, '後腿肉': true, '五花肉': true, '肉雞': true, '土雞': true,
  '鴨子': true, '雞蛋': true, '鴨蛋': true,
  '青蒜': true, '甘藍芽': true, '金針菜(乾)': true, '香菇(太空包)乾': true,
};

/**
 * The dataset's resource list: `{ month: 'YYYY-MM', rid }`, newest first.
 *
 * Scraped from the rendered page, because there is no API for it. The page
 * carries each UUID twice — once in the visible table, once inside the Nuxt
 * payload — and the payload copy sits next to an unrelated month label, so the
 * FIRST occurrence of a month wins: the visible table is rendered first, and a
 * second rid for a month we already have is the payload's artefact. (Verified:
 * the duplicate 114年12月 rid the payload yields answers the data API with no
 * result at all.)
 *
 * A scrape that comes back short of `MIN_RESOURCES` means the page changed
 * shape; the committed fixture takes over so a refit is not silently fitted on
 * three months of data.
 */
export async function fetchTaipeiResources(): Promise<{ resources: MonthlyResource[]; scraped: boolean }> {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as MonthlyResource[];
  let html = '';
  try {
    html = await cachedText('taipei', DATASET_PAGE, (text) => text.includes(DATASET_ID));
  } catch {
    return { resources: fixture, scraped: false };
  }
  const scraped = parseResources(html);
  if (scraped.length < MIN_RESOURCES) return { resources: fixture, scraped: false };
  return { resources: scraped, scraped: true };
}

/** Pairs every UUID on the page with the nearest ROC month label. Exported for the fixture test. */
export function parseResources(html: string): MonthlyResource[] {
  const byMonth: Record<string, string> = {};
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  for (let hit = uuid.exec(html); hit; hit = uuid.exec(html)) {
    if (hit[0] === DATASET_ID) continue;
    const from = Math.max(0, hit.index - LABEL_WINDOW);
    const window = html.slice(from, hit.index + LABEL_WINDOW);
    let nearest = '';
    let distance = Number.POSITIVE_INFINITY;
    for (const label of window.matchAll(/(\d{3})年(\d{1,2})月/g)) {
      const gap = Math.abs(from + (label.index ?? 0) - hit.index);
      if (gap >= distance) continue;
      distance = gap;
      nearest = `${Number(label[1]) + 1911}-${String(Number(label[2])).padStart(2, '0')}`;
    }
    if (nearest && !byMonth[nearest]) byMonth[nearest] = hit[0];
  }
  return Object.entries(byMonth)
    .map(([month, rid]) => ({ month, rid }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

/** One month's ~122 priced items, melted into quotes dated to the 1st of the month. */
export async function fetchTaipeiMonth(resource: MonthlyResource): Promise<{ quotes: RetailQuote[]; items: string[] }> {
  const url = `https://data.taipei/api/v1/dataset/${resource.rid}?scope=resourceAquire&limit=1000`;
  const body = await cachedText('taipei', url, (text) => text.includes('"results"'));
  const payload = JSON.parse(body) as { result?: { count?: number; results?: Record<string, string>[] } };
  const rows = payload.result?.results ?? [];
  if (!rows.length) throw new Error(`Taipei resource ${resource.rid} (${resource.month}) returned no rows`);
  return { quotes: meltTaipeiMonth(resource.month, rows), items: rows.map((r) => String(r[ITEM_KEY] ?? '')) };
}

export function meltTaipeiMonth(month: string, rows: Record<string, unknown>[]): RetailQuote[] {
  const quotes: RetailQuote[] = [];
  for (const row of rows) {
    const mapped = ITEM_TO_ROOT[String(row[ITEM_KEY] ?? '')];
    if (!mapped) continue;
    // Out-of-season items are published as "-", which Number() would read as NaN
    // for a bare "-" but as 0 for "" — both have to go.
    const price = Number(String(row[PRICE_KEY] ?? '').trim());
    if (!Number.isFinite(price) || price <= 0) continue;
    quotes.push({ date: `${month}-01`, root: mapped.root, item: mapped.item, price });
  }
  return quotes;
}

/** Item names that are neither mapped nor knowingly ignored. */
export function unmappedItems(items: string[]): string[] {
  return [...new Set(items)].filter((i) => i && !ITEM_TO_ROOT[i] && !IGNORED_ITEMS[i]).sort();
}
