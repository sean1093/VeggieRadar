/**
 * The run's output: a markdown report written to be pasted into issue #23.
 *
 * It is ordered the way the decision has to be made. The market table comes
 * first because every number after it is void if the mapping is wrong; then the
 * three questions, each with the statistic that settles it; then the per-crop
 * detail. Nothing here draws the conclusion — the report states what was
 * measured and how much of the board it covers, and a human decides.
 */
import { VIABLE_COVERAGE, quantile } from './measure.ts';
import type { CropStats, MarketSighting, RegionStats } from './measure.ts';
import { REGIONS } from './regions.ts';
import type { Region } from './regions.ts';

export type RunMeta = {
  from: string;
  to: string;
  minTradeVolume: number;
  requests: number;
  cacheHits: number;
  retries: number;
  failures: number;
  /** `<root> <ISO date>` per single day MOA truncated; see `FetchStats`. */
  truncated: string[];
  itemsRequested: number;
};

const pct = (n: number) => `${n.toFixed(1)}%`;
const tonnes = (kg: number) => `${(kg / 1000).toFixed(1)}`;

export function renderReport(meta: RunMeta, markets: MarketSighting[], crops: CropStats[]): string {
  const measured = crops.filter((c) => c.days > 0);
  const byVolume = [...measured].sort((a, b) => b.volume - a.volume);
  return [
    heading(meta, measured, markets),
    marketSection(markets),
    spreadSection(byVolume),
    coverageSection(measured),
    changeSection(measured),
    detailSection(byVolume),
  ].join('\n\n');
}

function heading(meta: RunMeta, measured: CropStats[], markets: MarketSighting[]): string {
  const days = Math.max(0, ...measured.map((c) => c.days));
  return [
    `# 分區行情可行性量測`,
    '',
    `| | |`,
    `| --- | --- |`,
    `| 期間 | ${meta.from} → ${meta.to} |`,
    `| 品項 | ${measured.length} / ${meta.itemsRequested} 有資料 |`,
    `| 最長交易日數 | ${days} |`,
    `| 市場 | ${markets.length} |`,
    `| MIN_TRADE_VOLUME | ${meta.minTradeVolume} kg（沿用後端設定） |`,
    `| MOA 請求 | ${meta.requests}（快取命中 ${meta.cacheHits}、重試 ${meta.retries}、失敗 ${meta.failures}） |`,
    // Halving has a floor, so a single day MOA still truncated keeps only its
    // newest rows: a partial market set, which reads exactly like a real
    // regional price difference. It cannot be re-fetched away, so it is stated.
    meta.truncated.length
      ? `| ⚠️ 被截斷的品項×日 | ${meta.truncated.length}：${truncatedList(meta.truncated)} —— 這些只拿到最新的部分市場，分區數字會偏 |`
      : `| 被截斷的品項×日 | 0 |`,
    '',
    '所有價格為 `元/台斤`，與看板顯示的單位一致；成交量為公斤。',
    '每日的全台與分區均價都由後端自己的 `selectRows` → `weightedAverage` 算出，',
    '本工具只負責分組與比較。',
  ].join('\n');
}

/**
 * The mapping check. An unmapped market is not a cosmetic gap: its volume still
 * counts toward the nationwide average that every deviation below is measured
 * against, while contributing to no region — so a large 其他 makes the regional
 * numbers describe a board nobody would ship.
 */
function marketSection(markets: MarketSighting[]): string {
  const total = markets.reduce((sum, m) => sum + m.volume, 0) || 1;
  const unmapped = markets.filter((m) => m.region === '其他');
  const unmappedShare = (unmapped.reduce((sum, m) => sum + m.volume, 0) / total) * 100;
  const rows = markets.map(
    (m) => `| ${m.name} | ${m.codes.join(', ') || '—'} | ${m.region} | ${m.days} | ${tonnes(m.volume)} | ${pct((m.volume / total) * 100)} |`,
  );
  return [
    `## 1. 市場對照表（issue #23 標註待驗證的那張）`,
    '',
    unmapped.length
      ? `> ⚠️ **${unmapped.length} 個市場未對應到區域**（占成交量 ${pct(unmappedShare)}）：${unmapped.map((m) => m.name).join('、')}。\n> 請把它們補進 \`src/regions.ts\` 的 \`REGION_BY_MARKET\` 後重跑（快取已在本機，重跑不再發請求）。`
      : `> ✅ 所有市場都有對應區域。`,
    '',
    `| 市場 | MarketCode | 區域 | 交易日 | 成交量（噸） | 占全國 |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...rows,
  ].join('\n');
}

/** Question 1: is there a regional difference worth showing? */
function spreadSection(byVolume: CropStats[]): string {
  const withSpread = byVolume.filter((c) => c.spreadDays > 0);
  // Top 20 BY VOLUME, not top 20 of those that happened to have a spread. An
  // item the board leans on that never has two qualifying regions is the most
  // important row in this table, and filtering it out would hide exactly what
  // section 3 exists to measure.
  const top = byVolume.slice(0, 20);
  const bands: { label: string; test: (c: CropStats) => boolean }[] = [
    { label: '< 5%', test: (c) => c.medianSpreadPct < 5 },
    { label: '5–10%', test: (c) => c.medianSpreadPct >= 5 && c.medianSpreadPct < 10 },
    { label: '10–20%', test: (c) => c.medianSpreadPct >= 10 && c.medianSpreadPct < 20 },
    { label: '≥ 20%', test: (c) => c.medianSpreadPct >= 20 },
  ];
  return [
    `## 2. 區域價差有多大`,
    '',
    `每個交易日取「當天有資格的區域中最貴與最便宜的差」÷「全台價」，再取該品項所有交易日的中位數。`,
    `這就是使用者切換區域後，小字批發價最多會變動的幅度。`,
    '',
    `| 價差中位數 | 品項數 | 占有量測到價差的品項 |`,
    `| --- | --- | --- |`,
    ...bands.map((band) => {
      const n = withSpread.filter(band.test).length;
      const share = withSpread.length ? (n / withSpread.length) * 100 : 0;
      return `| ${band.label} | ${n} | ${pct(share)} |`;
    }),
    '',
    `成交量前 20 大品項（"—" = 從來沒有兩個區域同時有資格，無從比較）：`,
    '',
    `| 品項 | 交易日 | 有 ≥2 區的日數 | 價差中位數 | 價差 p90 |`,
    `| --- | --- | --- | --- | --- |`,
    ...top.map((c) =>
      c.spreadDays
        ? `| ${c.name} | ${c.days} | ${c.spreadDays} | ${pct(c.medianSpreadPct)} | ${pct(c.p90SpreadPct)} |`
        : `| ${c.name} | ${c.days} | 0 | — | — |`,
    ),
  ].join('\n');
}

/** Question 2: does each region have enough trade to survive the gate? */
function coverageSection(measured: CropStats[]): string {
  const perRegion = REGIONS.map((region) => {
    const stats = measured.map((c) => statsFor(c, region));
    const viable = stats.filter((s) => s.viable).length;
    const never = stats.filter((s) => s.qualifiedDays === 0).length;
    return { region, viable, never, total: measured.length, stats };
  });
  const byCount = [0, 1, 2, 3, 4].map((n) => ({
    n,
    items: measured.filter((c) => c.viableRegions === n).length,
  }));
  return [
    `## 3. 每一區的樣本量夠不夠`,
    '',
    `「可行」= 該區在 ≥ ${pct(VIABLE_COVERAGE * 100)} 的交易日達到 \`MIN_TRADE_VOLUME\`，也就是切過去不會常常是空的。`,
    '',
    `| 區域 | 可行品項 | 完全沒資格的品項 | 可行率 |`,
    `| --- | --- | --- | --- |`,
    ...perRegion.map(
      (r) => `| ${r.region} | ${r.viable} / ${r.total} | ${r.never} | ${pct(r.total ? (r.viable / r.total) * 100 : 0)} |`,
    ),
    '',
    `每個品項撐得起幾個區域：`,
    '',
    `| 可行區域數 | 品項數 |`,
    `| --- | --- |`,
    ...byCount.map((b) => `| ${b.n} | ${b.items} |`),
  ].join('\n');
}

/** Question 3: would a regional change-percent be a price move or a market-mix move? */
function changeSection(measured: CropStats[]): string {
  const rows = REGIONS.map((region) => {
    const stats = measured.map((c) => statsFor(c, region)).filter((s) => s.changePairs > 0);
    return {
      region,
      items: stats.length,
      medianGap: quantile(stats.map((s) => s.medianChangeGapPct), 0.5),
      p90Gap: quantile(stats.map((s) => s.p90ChangeGapPct), 0.5),
      churn: quantile(stats.map((s) => s.mixChurn), 0.5) * 100,
      gapDays: quantile(stats.map((s) => s.medianGapDays), 0.5),
    };
  });
  return [
    `## 4. 分區漲跌幅可不可信`,
    '',
    `\`changeGap\` = |該區日比較漲跌% − 同一組日期的全台漲跌%|。先算每個品項自己的中位數與 p90，`,
    `再取品項之間的中位數 —— 所以 p90 欄是「典型品項的壞日子」，不是所有日子的 p90。`,
    `\`mixChurn\` = 相鄰兩個「有資格的交易日」之間，該區貢獻市場組成改變的比例 —— 批發市場各自固定休市，`,
    `分區之後一家休市就可能換掉一半樣本，此時漲跌反映的是市場組成而不是價格。`,
    '',
    `| 區域 | 有日比較的品項 | changeGap 中位數 | changeGap p90（品項中位數） | mixChurn | 相鄰交易日間隔 |`,
    `| --- | --- | --- | --- | --- | --- |`,
    // A region nothing qualified in has no measured gap; printing 0.0% would
    // read as "perfectly consistent with the nationwide move", the opposite of
    // what an empty sample means.
    ...rows.map((r) =>
      r.items
        ? `| ${r.region} | ${r.items} | ${pct(r.medianGap)} | ${pct(r.p90Gap)} | ${pct(r.churn)} | ${r.gapDays.toFixed(1)} 天 |`
        : `| ${r.region} | 0 | — | — | — | — |`,
    ),
  ].join('\n');
}

function detailSection(byVolume: CropStats[]): string {
  return [
    `## 5. 每個品項`,
    '',
    `覆蓋率 = 該區達到 \`MIN_TRADE_VOLUME\` 的交易日比例。偏離 = 該區價格相對全台的中位數（帶正負號）。`,
    '',
    `| 品項 | 類別 | 交易日 | 成交量（噸） | 價差中位數 | 可行區域 | ${REGIONS.map((r) => `${r} 覆蓋/偏離`).join(' | ')} |`,
    `| --- | --- | --- | --- | --- | --- | ${REGIONS.map(() => '---').join(' | ')} |`,
    ...byVolume.map((c) => {
      const cells = REGIONS.map((region) => {
        const s = statsFor(c, region);
        return s.qualifiedDays ? `${pct(s.coverage * 100)} / ${s.medianDeviationPct >= 0 ? '+' : ''}${pct(s.medianDeviationPct)}` : '—';
      });
      return `| ${c.name} | ${c.category} | ${c.days} | ${tonnes(c.volume)} | ${c.spreadDays ? pct(c.medianSpreadPct) : '—'} | ${c.viableRegions} | ${cells.join(' | ')} |`;
    }),
  ].join('\n');
}

/** At most a handful of names, so the header stays a header. */
function truncatedList(truncated: string[]): string {
  const shown = [...truncated].sort().slice(0, 5).join('、');
  return truncated.length > 5 ? `${shown} …` : shown;
}

function statsFor(crop: CropStats, region: Region): RegionStats {
  const found = crop.regions.find((r) => r.region === region);
  if (!found) throw new Error(`crop ${crop.name} has no stats for region ${region}`);
  return found;
}
