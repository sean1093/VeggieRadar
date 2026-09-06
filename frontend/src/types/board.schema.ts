/**
 * The executable contract between the Apps Script backend and this client.
 *
 * Why a runtime schema for shapes TypeScript already checks: the board is
 * assembled by `backend/*.gs` — untyped ES5 — and arrives as untyped JSON, so
 * `types/produce.ts` was only ever a *claim* about the payload. A field renamed
 * on the backend reaches the UI as `undefined` and renders nothing: no error,
 * no failed build, just a card that quietly lost its price. These schemas are
 * the single definition of that payload, checked from three sides:
 *
 *   - `types/produce.ts` infers its types from them, so there is no second,
 *     drifting hand-written copy;
 *   - `api.ts` measures every live board against them (report-only) and
 *     `scripts/prod-probe.mjs` measures production every 6 hours;
 *   - `mockBoard.test.ts` holds the bundled offline board to them, and
 *     `backendCode.test.ts` runs the real `buildBoard()` output through them,
 *     so the two sides are compared in CI rather than in front of a shopper.
 *
 * Three deliberate properties:
 *
 *   - **Validation only — never transformation.** Callers read `boardMismatch`
 *     (or `safeParse().success`) and keep the payload they were given; the
 *     parse *output* is deliberately never used, and nothing here coerces or
 *     defaults. The objects are neither strict nor loose: unknown keys are
 *     accepted because README §3 promises an old client keeps working against
 *     a newer board, while a loose object's inferred catch-all index signature
 *     would make every misspelled field in the UI type-check — the exact class
 *     of bug this file exists to catch.
 *   - **`zod/mini`, not the classic API.** Measured on this bundle, classic zod
 *     adds 83 kB (22.9 kB gzip) to the entry chunk against 18 kB (5.7 kB) for
 *     mini — for identical validation. The board is the entry chunk and most
 *     visits never leave it, which is the same reason recharts is code-split
 *     (§2); paying a quarter of the app's transfer for a diagnostic would be
 *     the wrong trade. What mini drops is the prose in error messages, so
 *     `boardMismatch` composes the summary from the issue itself.
 *   - **Type-erasable syntax only.** `scripts/prod-probe.mjs` imports this file
 *     under Node's type stripping, which refuses enums and parameter
 *     properties (`erasableSyntaxOnly` in `tsconfig.app.json` enforces it).
 *
 * `z.number()` rejects `NaN` and `Infinity` on its own (zod 4), so the numeric
 * fields need no extra `.finite()` — a non-finite price is a schema violation.
 */
import * as z from 'zod/mini';

/** 單一品種的當日行情摘要（抽屜「今日品種行情」用）。 */
export const ProduceVarietySchema = z.object({
  name: z.string(),           // 品種名，如「綠竹筍」；MOA 未標品種者為「一般」
  catty_price: z.number(),    // 批發，元/台斤（該品種成交量加權平均，實測值）
  share_percent: z.number(),  // 佔該品項總成交量的百分比（小品種被摺疊時總和 < 100）
  // 推估菜市場價（元/台斤）＝ 該品種批發價 + 與卡片相同的攤販加成。因加成是
  // 加法常數，卡片大字恰為各品種依成交量加權的平均。舊版快取可能沒有此欄位。
  retail_price: z.optional(z.number()),
});

export const ProduceItemSchema = z.object({
  code: z.string(),
  name: z.string(),             // 顯示用俗名，如「高麗菜」
  official_name: z.string(),    // 農業部官方名，如「甘藍」
  category: z.string(),         // 葉菜類 / 根莖類 / 瓜果類 / 果菜類 / 辛香類 / 水果 / 其他
  avg_price: z.number(),        // 元 / 公斤（全市場成交量加權平均）
  catty_price: z.number(),      // 元 / 台斤
  change_percent: z.number(),   // 與前一交易日相比
  trade_volume: z.number(),     // 公斤
  unit: z.string(),             // 公斤
  markets_count: z.number(),    // 納入平均的市場數

  // 傳統市場零售「參考」價（元 / 台斤）。由批發價加上校準過的攤販加成估算，
  // 不是實際報價 —— 後端以 retail_estimated 標示。舊版回應可能沒有這些欄位。
  retail_low: z.optional(z.number()),
  retail_price: z.optional(z.number()),
  retail_high: z.optional(z.number()),
  // 只會是 true：後端只在附上零售估算區間時送出這個旗標，不存在 false（§4）。
  retail_estimated: z.optional(z.literal(true)),
  // 「跟平常比」基準（批發基準）：近 28 個交易日的中位數。baseline_price 為
  // 元/台斤；vs_baseline_percent 為今日批發價相對中位數的百分比（負值 = 比平常
  // 便宜）。歷史不足（新品項、剛回產季、尚未回填）時後端不送這兩個欄位。
  baseline_price: z.optional(z.number()),
  vs_baseline_percent: z.optional(z.number()),
  // 當日品種分解（批發）。只有 ≥2 個具意義品種（各佔量 ≥10%）時後端才送，
  // 依成交量排序、至多 4 筆。混合均價偏離個別攤位時，抽屜用它拆解。
  varieties: z.optional(z.array(ProduceVarietySchema)),

  // Optional — only present in some responses / kept for the detail drawer.
  market: z.optional(z.string()),
  origin: z.optional(z.string()),
  upper_price: z.optional(z.number()),
  middle_price: z.optional(z.number()),
  lower_price: z.optional(z.number()),
  trend: z.optional(z.array(z.number())),
});

export const BoardResponseSchema = z.object({
  type: z.literal('board'),
  date: z.string(),       // ISO 交易日期, e.g. 2026-08-26 —— 休市時會停在最近一次交易日
  roc_date: z.string(),   // 115.08.26
  prev_date: z.string(),
  count: z.number(),
  items: z.array(ProduceItemSchema),
  cached: z.optional(z.boolean()),

  // 後端最後一次爬取的時間（ISO）與新鮮度旗標。交易日期停住是正常的（休市），
  // 但 generated_at 停住代表更新流程壞了 —— 兩者必須分開呈現。
  generated_at: z.optional(z.string()),
  age_ms: z.optional(z.nullable(z.number())),
  stale: z.optional(z.boolean()),
  warming: z.optional(z.boolean()),
});

export const SearchResponseSchema = z.object({
  type: z.literal('search'),
  query: z.string(),
  date: z.string(),
  count: z.number(),
  items: z.array(ProduceItemSchema),
});

/**
 * The first way a payload breaks the board contract, or null when it holds.
 *
 * One violation, not all of them: a renamed field yields the same path on
 * every visit, which keeps the analytics event's cardinality bounded and the
 * probe's issue comment readable. `zod/mini` ships no message map (that is
 * most of what makes it small), so the summary is composed from the issue's
 * own fields — `expected` is what identifies a type change anyway.
 */
export function boardMismatch(payload: unknown): { path: string; message: string } | null {
  const result = BoardResponseSchema.safeParse(payload);
  if (result.success) return null;
  const [issue] = result.error.issues;
  return {
    path: issue.path.join('.'),
    message: 'expected' in issue ? `${issue.code}: expected ${issue.expected}` : issue.code,
  };
}

/**
 * Board size thresholds, in one place because two independent guards need the
 * same numbers and a drift between them would be invisible.
 *
 * `BOARD_MIN_ITEMS` is the hard floor: a board this small is not published at
 * all. The backend enforces it (`BOARD_MIN_ITEMS` in `backend/Config.gs`) and
 * that constant MUST equal this one — a stricter backend would silently keep
 * serving the old board while every external check called the result healthy.
 */
export const BOARD_MIN_ITEMS = 30;

/**
 * `BOARD_HEALTHY_ITEMS` is what production is *expected* to carry: a typical
 * day publishes ~90 of the ~100 defined items (§1), and MOA throttling a batch
 * shows up as a board that is complete enough to serve yet clearly short. It
 * sits above the floor on purpose, so the external probe
 * (`scripts/prod-probe.mjs`) alerts on that degradation instead of waiting for
 * the board to collapse below the publishing threshold.
 */
export const BOARD_HEALTHY_ITEMS = 60;
