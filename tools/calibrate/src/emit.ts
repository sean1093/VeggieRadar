/**
 * The two artefacts: `backend/RetailCalibration.gs` and this month's report.
 *
 * The `.gs` file holds nothing but the three tables. It is the only place they
 * exist — `Config.gs` keeps the non-data constants — so a refit is a diff a
 * human reads, not an edit someone makes by hand.
 *
 * `--keep-shipped` writes the tables that are live today instead of the fitted
 * ones, and puts the refit in the report as a proposal. That is the honest
 * option whenever the refit is not demonstrably better: replacing working
 * constants on a measurement nobody has validated is a guess in a nice suit.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBackend, loadCommittedBackend, REPO_ROOT } from './backend.ts';
import { RETAIL_MARKUP_CATEGORY } from './category-bands.ts';
import type { MarkupBand } from './category-bands.ts';
import type { CropFit } from './fit.ts';
import { MIN_OBSERVATIONS } from './fit.ts';
import type { Holdout } from './evaluate.ts';
import type { JoinReport } from './join.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPORT_DIR = resolve(HERE, '../report');
export const GENERATED_GS = resolve(REPO_ROOT, 'backend/RetailCalibration.gs');

/** The tables as they are DEPLOYED (read from HEAD), for the old-vs-new diff. */
export type ShippedTables = { markupRoot: Record<string, number>; bandRoot: Record<string, MarkupBand> };

export type CropChange = {
  root: string;
  /** Effective midpoint markup before and after, falling back to the category mid. */
  before: number;
  after: number;
  delta: number;
  note: string;
};

export type Reproduction = {
  /** Tier-1 crops present in both the shipped table and the refit. */
  tier1: { common: number; medianAbsDelta: number; offBy5: string[]; added: string[]; dropped: string[] };
  tier2: { common: number; within2: number; medianAbsDelta: number; added: string[]; dropped: string[] };
  /** True when the refit reproduces the shipped tier-2 table closely enough to adopt. */
  gate: boolean;
};

export type EmitOptions = { keepShipped: boolean; generatedOn: string; dataThrough: string };

export type EmitResult = { gsPath: string; reportPath: string; reproduction: Reproduction; changes: CropChange[] };

/**
 * The deployed tables, read through the backend loader so there is no second
 * copy — and from the COMMITTED source, so a rerun in a tree this tool has
 * already written to still compares against what is live. See
 * `loadCommittedBackend`.
 */
export function shippedTables(): ShippedTables {
  const backend = loadCommittedBackend();
  const bandRoot: Record<string, MarkupBand> = {};
  for (const [root, band] of Object.entries(backend.RETAIL_BAND_ROOT)) {
    bandRoot[root] = [band[0], band[1], band[2]];
  }
  return { markupRoot: { ...backend.RETAIL_MARKUP_ROOT }, bandRoot };
}

/** The fitted tables, in the shape the generated file needs. */
export function fittedTables(fits: CropFit[]): ShippedTables {
  const markupRoot: Record<string, number> = {};
  const bandRoot: Record<string, MarkupBand> = {};
  for (const fit of fits) {
    if (!fit.listed) continue;
    if (fit.tier === 'tier1' && fit.markup !== undefined) markupRoot[fit.root] = fit.markup;
    if (fit.tier === 'tier2' && fit.band) bandRoot[fit.root] = fit.band;
  }
  return { markupRoot, bandRoot };
}

/**
 * How faithfully the refit reproduces what shipped — the measurement the
 * decision to adopt or keep rests on.
 *
 * `gate` encodes the adoption rule: the refit is close enough to be a
 * reproduction (rather than a different answer) when at least 17 of the 21
 * shipped tier-2 medians land within NT$2. Tier 1 is reported but never gates:
 * its shipped values were fitted on a window that overlaps any holdout, so a
 * favourable comparison would flatter them.
 */
export function compareWithShipped(fits: CropFit[], shipped: ShippedTables): Reproduction {
  const refit = fittedTables(fits);
  const backend = loadBackend();

  const tier1Common = Object.keys(shipped.markupRoot).filter((r) => refit.markupRoot[r] !== undefined);
  const tier1Deltas = tier1Common.map((r) => Math.abs(refit.markupRoot[r] - shipped.markupRoot[r]));
  const tier2Common = Object.keys(shipped.bandRoot).filter((r) => refit.bandRoot[r] !== undefined);
  const tier2Deltas = tier2Common.map((r) => Math.abs(refit.bandRoot[r][1] - shipped.bandRoot[r][1]));
  const within2 = tier2Deltas.filter((d) => d <= 2).length;

  return {
    tier1: {
      common: tier1Common.length,
      medianAbsDelta: tier1Deltas.length ? backend.median(tier1Deltas) : 0,
      offBy5: tier1Common.filter((r) => Math.abs(refit.markupRoot[r] - shipped.markupRoot[r]) > 5).sort(),
      added: Object.keys(refit.markupRoot).filter((r) => shipped.markupRoot[r] === undefined).sort(),
      dropped: Object.keys(shipped.markupRoot).filter((r) => refit.markupRoot[r] === undefined).sort(),
    },
    tier2: {
      common: tier2Common.length,
      within2,
      medianAbsDelta: tier2Deltas.length ? backend.median(tier2Deltas) : 0,
      added: Object.keys(refit.bandRoot).filter((r) => shipped.bandRoot[r] === undefined).sort(),
      dropped: Object.keys(shipped.bandRoot).filter((r) => refit.bandRoot[r] === undefined).sort(),
    },
    gate: within2 >= 17,
  };
}

/**
 * Behavioural change per crop, in NT$ of midpoint markup.
 *
 * A crop that gains or loses its own entry is compared against the category
 * mid it falls back to, because that — not the absence of a table row — is
 * what the card's big digits would move by.
 */
export function changeList(fits: CropFit[], shipped: ShippedTables): CropChange[] {
  const refit = fittedTables(fits);
  const backend = loadBackend();
  const roots = [...new Set([
    ...Object.keys(shipped.markupRoot), ...Object.keys(shipped.bandRoot),
    ...Object.keys(refit.markupRoot), ...Object.keys(refit.bandRoot),
  ])];

  const changes: CropChange[] = [];
  for (const root of roots) {
    const fallback = RETAIL_MARKUP_CATEGORY[backend.categoryOf(root)] ?? RETAIL_MARKUP_CATEGORY['其他'];
    const before = shipped.markupRoot[root] ?? shipped.bandRoot[root]?.[1] ?? fallback[1];
    const after = refit.markupRoot[root] ?? refit.bandRoot[root]?.[1] ?? fallback[1];
    const wasListed = shipped.markupRoot[root] !== undefined || shipped.bandRoot[root] !== undefined;
    const isListed = refit.markupRoot[root] !== undefined || refit.bandRoot[root] !== undefined;
    const note = !wasListed ? 'newly listed' : !isListed ? 'no longer listed (falls back to category)' : 'refitted';
    changes.push({ root, before, after, delta: Math.abs(after - before), note });
  }
  return changes.sort((a, b) => b.delta - a.delta || a.root.localeCompare(b.root));
}

/** Renders one `var NAME = { ... };` block, keys in code-point order, wrapped. */
function gsTable(name: string, entries: [string, string][], perLine: number): string {
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i += perLine) {
    lines.push('  ' + entries.slice(i, i + perLine).map(([k, v]) => `'${k}': ${v}`).join(', '));
  }
  return `var ${name} = {\n${lines.join(',\n')}\n};`;
}

export function renderGs(tables: ShippedTables, options: EmitOptions): string {
  // Fitted keys sort, so a refit that changes nothing is an empty diff. The
  // category table keeps its source order instead: that order is the board's
  // category order, which is information a sort would throw away.
  const markupEntries = Object.keys(tables.markupRoot).sort()
    .map((root): [string, string] => [root, String(tables.markupRoot[root])]);
  const bandEntries = Object.keys(tables.bandRoot).sort()
    .map((root): [string, string] => [root, `[${tables.bandRoot[root].join(', ')}]`]);
  const categoryEntries = Object.entries(RETAIL_MARKUP_CATEGORY)
    .map(([category, band]): [string, string] => [category, `[${band.join(', ')}]`]);

  return [
    `// GENERATED by tools/calibrate on ${options.generatedOn} from data through ${options.dataThrough}. Do not edit by hand.`,
    '//',
    '// Estimated traditional-market retail markup in 元/台斤, ADDED to the',
    '// wholesale catty price. Three tiers, most specific first; `retailBand` in',
    '// Aggregate.gs picks between them and rounds the result outward to NT$5.',
    '//',
    '// The model, the tiers and the rules that decide what is listed are',
    `// documented in README §4. This month's fit, its held-out accuracy and the`,
    `// per-crop observation counts are in tools/calibrate/report/${options.dataThrough}.md.`,
    options.keepShipped
      ? '//\n// Values carried over unchanged: this run\'s refit is reported as a proposal,\n// not adopted. See the report for the old-vs-new comparison.'
      : '//\n// Values are this run\'s fit.',
    '',
    '/** Tier 1: fitted midpoint markup; the band is a fixed multiple of it. */',
    gsTable('RETAIL_MARKUP_ROOT', markupEntries, 6),
    '',
    `/** Tier 2: fitted [p10, median, p90] of the crop's own markup distribution. */`,
    gsTable('RETAIL_BAND_ROOT', bandEntries, 4),
    '',
    '/** Tier 3: hand-tuned per-category [low, mid, high] fallback. Not fitted. */',
    gsTable('RETAIL_MARKUP_CATEGORY', categoryEntries, 1),
    '',
  ].join('\n');
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function renderReport(
  fits: CropFit[],
  holdout: Holdout,
  join: JoinReport,
  shipped: ShippedTables,
  reproduction: Reproduction,
  changes: CropChange[],
  options: EmitOptions,
): string {
  const refit = fittedTables(fits);
  const ruleLabels: Record<string, string> = {
    'category': 'Category fallback (previous behaviour)',
    'tier1-style': 'Per-crop midpoint with tier 1\'s × 0.75 … × 1.35 band',
    'per-crop-quantile': 'Per-crop [p10, median, p90]',
  };

  const lines: string[] = [
    `# Retail markup calibration — data through ${options.dataThrough}`,
    '',
    `Generated by \`tools/calibrate\` on ${options.generatedOn}. ` +
    `Emitted tables: **${options.keepShipped ? 'the values already shipped' : 'this run\'s fit'}**.`,
    '',
    '<!-- pr-summary:start -->',
    '## Held-out accuracy',
    '',
    `${holdout.crops.length} crops, ${holdout.observations} held-out observations ` +
    `(newest 20% of each crop's history, fitted on the older 80%, split strictly by date).`,
    '',
    '| Rule | Band coverage | Median abs. error |',
    '| --- | --- | --- |',
  ];
  for (const score of holdout.scores) {
    lines.push(`| ${ruleLabels[score.rule]} | ${percent(score.coverage)} | ${percent(score.medianAbsError)} |`);
  }

  lines.push(
    '',
    '## Reproduction of the shipped tables',
    '',
    `| | crops in both | median \\|Δ\\| | added | dropped |`,
    '| --- | --- | --- | --- | --- |',
    `| Tier 1 \`RETAIL_MARKUP_ROOT\` | ${reproduction.tier1.common} | NT$${reproduction.tier1.medianAbsDelta} | ` +
    `${reproduction.tier1.added.join(' ') || '—'} | ${reproduction.tier1.dropped.join(' ') || '—'} |`,
    `| Tier 2 \`RETAIL_BAND_ROOT\` | ${reproduction.tier2.common} | NT$${reproduction.tier2.medianAbsDelta} | ` +
    `${reproduction.tier2.added.join(' ') || '—'} | ${reproduction.tier2.dropped.join(' ') || '—'} |`,
    '',
    `Tier-1 crops off by more than NT$5: ${reproduction.tier1.offBy5.join(', ') || 'none'}.`,
    '',
    `Adoption gate — at least 17 of the shipped tier-2 medians within NT$2: ` +
    `**${reproduction.tier2.within2} of ${reproduction.tier2.common} → ${reproduction.gate ? 'pass' : 'fail'}**.`,
    '',
    '## Ten largest changes',
    '',
    '| Crop | midpoint before | after | Δ | |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const change of changes.slice(0, 10)) {
    lines.push(`| ${change.root} | ${change.before} | ${change.after} | ${change.after - change.before} | ${change.note} |`);
  }
  lines.push('<!-- pr-summary:end -->', '');

  lines.push(
    '## What was read',
    '',
    `- 臺中市公有零售市場每日蔬果價格表 — ${join.taichung.rows} rows, ${join.taichung.from} … ${join.taichung.to}, ` +
    `${join.taichung.roots} MOA roots mapped` +
    (join.taichung.unmapped.length ? `, UNMAPPED: ${join.taichung.unmapped.join(', ')}` : ''),
    `- 臺北市公有零售市場行情 — ${join.taipei.months.length} monthly snapshots ` +
    `(${join.taipei.months[0]} … ${join.taipei.months[join.taipei.months.length - 1]}, ` +
    `${join.taipei.scraped ? 'resource list scraped' : 'resource list from the committed fixture'}), ` +
    `${join.taipei.roots} MOA roots mapped` +
    (join.taipei.unmapped.length ? `, UNMAPPED: ${join.taipei.unmapped.join(', ')}` : ''),
    `- MOA wholesale — ${join.moa.roots} roots over ${join.moa.windows} date windows, ` +
    `${join.observations.length} paired observations`,
    '',
    '## Every crop with observations',
    '',
    `Tier 1 needs ${MIN_OBSERVATIONS} daily Taichung observations; tier 2 needs ${MIN_OBSERVATIONS} monthly ` +
    'Taipei ones and a band strictly narrower than its category. `emitted` is what the generated file carries.',
    '',
    '| Crop | category | Taichung obs | Taipei obs | tier | shipped | refit | emitted | why |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  const emitted = options.keepShipped ? shipped : refit;
  for (const fit of fits) {
    const show = (tables: ShippedTables) => {
      if (tables.markupRoot[fit.root] !== undefined) return String(tables.markupRoot[fit.root]);
      if (tables.bandRoot[fit.root]) return `[${tables.bandRoot[fit.root].join(', ')}]`;
      return '—';
    };
    lines.push(
      `| ${fit.root} | ${fit.category} | ${fit.counts.taichung} | ${fit.counts.taipei} | ` +
      `${fit.listed ? fit.tier : 'category'} | ${show(shipped)} | ${show(refit)} | ${show(emitted)} | ${fit.reason} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function emit(
  fits: CropFit[],
  holdout: Holdout,
  join: JoinReport,
  shipped: ShippedTables,
  options: EmitOptions,
): EmitResult {
  const reproduction = compareWithShipped(fits, shipped);
  const changes = changeList(fits, shipped);
  const tables = options.keepShipped ? shipped : fittedTables(fits);

  writeFileSync(GENERATED_GS, renderGs(tables, options));
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = resolve(REPORT_DIR, `${options.dataThrough}.md`);
  writeFileSync(reportPath, renderReport(fits, holdout, join, shipped, reproduction, changes, options));
  return { gsPath: GENERATED_GS, reportPath, reproduction, changes };
}
