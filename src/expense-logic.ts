export type ExpenseCorrection = {
  category?: string | null;
  memo?: string | null;
  store?: string | null;
  amount?: number | null;
  spent_at?: string | null;
};

export type CategoryConfig = {
  categories: readonly string[];
  aliases: Readonly<Record<string, string>>;
  plannedWords?: readonly string[];
  savingsWords?: readonly string[];
};

export const SCOLD_LEVEL1_MIN_AMOUNT = 10_000;
export const SCOLD_LEVEL2_MIN_AMOUNT = 20_000;
export const SCOLD_LEVEL3_MIN_AMOUNT = 40_000;

export type ScoldLevel = 0 | 1 | 2 | 3;

export function scoldLevel(category: string | null | undefined, amount: number): ScoldLevel {
  if (category !== "趣味" || !Number.isFinite(amount) || amount < SCOLD_LEVEL1_MIN_AMOUNT) return 0;
  if (amount >= SCOLD_LEVEL3_MIN_AMOUNT) return 3;
  if (amount >= SCOLD_LEVEL2_MIN_AMOUNT) return 2;
  return 1;
}

export type ExpenseRangeSpec =
  | { kind: "all" }
  | { kind: "month"; year: number; month: number };

export type ExpenseRangeResult = ExpenseRangeSpec | { kind: "invalid" };

type ExpenseMonthToday = { year: number; month: number };

function monthRange(year: number, month: number): ExpenseRangeSpec {
  return { kind: "month", year, month };
}

function shiftedMonth(today: ExpenseMonthToday, monthsAgo: number): ExpenseRangeSpec {
  const date = new Date(Date.UTC(today.year, today.month - 1 - monthsAgo, 1));
  return monthRange(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

function validYearMonth(year: number, month: number): ExpenseRangeSpec | null {
  if (year < 2000 || year > 2099 || month < 1 || month > 12) return null;
  return monthRange(year, month);
}

/** Parse a user-entered month without consulting the database or current time. */
export function parseExpenseMonth(input: string, today: ExpenseMonthToday): ExpenseRangeResult {
  const normalized = input.normalize("NFKC").trim();
  if (!normalized) return { kind: "invalid" };

  const delimited = normalized.match(/^(\d{4})([-\/])(\d{1,2})(?:\2\d{1,2})?$/);
  if (delimited) {
    const year = Number(delimited[1]);
    const month = Number(delimited[3]);
    return validYearMonth(year, month) ?? { kind: "invalid" };
  }

  const japanese = normalized.match(/^(\d{4})年(\d{1,2})月(?:\d{1,2}日)?$/);
  if (japanese) {
    const year = Number(japanese[1]);
    const month = Number(japanese[2]);
    return validYearMonth(year, month) ?? { kind: "invalid" };
  }

  const monthOnly = normalized.match(/^(\d{1,2})月?$/);
  if (monthOnly) {
    const month = Number(monthOnly[1]);
    if (month < 1 || month > 12) return { kind: "invalid" };
    const year = month > today.month ? today.year - 1 : today.year;
    return monthRange(year, month);
  }

  return { kind: "invalid" };
}

export function resolveExpenseRange(
  input: { range?: string; month?: string },
  today: ExpenseMonthToday
): ExpenseRangeResult {
  const month = typeof input.month === "string" ? input.month.normalize("NFKC").trim() : "";
  if (month) return parseExpenseMonth(month, today);

  const range = typeof input.range === "string" ? input.range.normalize("NFKC").trim() : "";
  if (!range || range === "month") return monthRange(today.year, today.month);
  if (range === "last_month") return shiftedMonth(today, 1);
  if (range === "two_months_ago") return shiftedMonth(today, 2);
  if (range === "all") return { kind: "all" };
  return { kind: "invalid" };
}

export type ExpenseDateRange = { start: string; end: string };

export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function expenseRangeBounds(spec: ExpenseRangeSpec): ExpenseDateRange | null {
  if (spec.kind === "all") return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    start: `${spec.year}-${pad(spec.month)}-01T00:00:00+09:00`,
    end: `${spec.year}-${pad(spec.month)}-${pad(lastDayOfMonth(spec.year, spec.month))}T23:59:59+09:00`
  };
}

export type ExpenseCandidateEventLike = {
  type?: string;
  amount?: number | null;
  item?: string | null;
  content?: string | null;
  request_guidance?: boolean;
};

export function isExpenseCandidateComplete(event: ExpenseCandidateEventLike): boolean {
  const item = event.item ?? event.content;
  return Boolean(event.amount) && typeof item === "string" && item.trim().length > 0;
}

export function dropChatReplyWhenExpenseCard<T extends ExpenseCandidateEventLike>(events: T[]): T[] {
  const hasExpenseCard = events.some(
    (event) => event.type === "expense_candidate" && isExpenseCandidateComplete(event)
  );
  if (!hasExpenseCard) return events;
  return events.filter((event) => event.type !== "chat_reply" || event.request_guidance);
}

export type CorrectionTargetInput = {
  isReply: boolean;
  referencedPending: boolean;
  referencedBotExpenseCard: boolean;
  pendingCount: number;
};

export type CorrectionTargetDecision =
  | "reply_match"
  | "reply_expired_or_processed"
  | "single_pending"
  | "no_pending"
  | "ambiguous";

export type ExpenseLikeRow = {
  id?: number;
  amount: number;
  category?: string | null;
  memo: string;
  store?: string | null;
  spent_at: string;
};

export type ExpenseHierarchySection = {
  category: string;
  header: string;
  details: string[];
  overflow: number;
};

export type ExpenseContentParts = {
  header: string[];
  sections?: ExpenseHierarchySection[];
  details?: string[];
};

export type ExpenseCategoryTotal = {
  category: string;
  total: number;
};

export type ExpenseSummary = {
  total: number;
  byCategory: readonly ExpenseCategoryTotal[];
};

export type SavingsStatusRow = {
  memo: string | null;
  total: number | null;
  n: number | null;
  last: string | null;
};

const CATEGORY_DESIGNATION_SUFFIXES = ["で", "に", "として"] as const;
const CORRECTION_CUE = /にして|に変えて|じゃなくて|直して|訂正|さっきの|間違い|違う|ちがう/;

function normalizedCategoryEntries(config: CategoryConfig): { value: string; normalized: string }[] {
  return config.categories
    .map((category) => String(category).trim())
    .filter(Boolean)
    .map((value) => ({ value, normalized: value.normalize("NFKC") }))
    .filter((entry, index, entries) => entries.findIndex((other) => other.normalized === entry.normalized) === index);
}

function canonicalCategory(value: string, config: CategoryConfig): string | null {
  const normalized = value.normalize("NFKC").trim();
  return normalizedCategoryEntries(config).find((entry) => entry.normalized === normalized)?.value ?? null;
}

function categoryTerms(config: CategoryConfig): { value: string; normalized: string; category: string }[] {
  const terms = normalizedCategoryEntries(config).map((entry) => ({
    value: entry.value,
    normalized: entry.normalized,
    category: entry.value
  }));
  for (const [alias, target] of Object.entries(config.aliases)) {
    const value = String(alias).trim();
    const category = canonicalCategory(String(target), config);
    if (!value || !category) continue;
    const normalized = value.normalize("NFKC");
    if (terms.some((term) => term.normalized === normalized)) continue;
    terms.push({ value, normalized, category });
  }
  return terms;
}

function categoryAlternation(config: CategoryConfig): string {
  return categoryTerms(config)
    .sort((a, b) => b.normalized.length - a.normalized.length)
    .map((entry) => escapeRegExp(entry.normalized))
    .join("|");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function categoryFromNormalized(value: string, config: CategoryConfig): string | null {
  const normalized = value.normalize("NFKC").trim();
  const term = categoryTerms(config).find((entry) => entry.normalized === normalized);
  return term?.category ?? null;
}

function categoryOccurrences(text: string, config: CategoryConfig): { category: string; index: number; suffix: string }[] {
  const entries = categoryTerms(config).sort((a, b) => b.normalized.length - a.normalized.length);
  const occurrences: { category: string; index: number; suffix: string }[] = [];
  for (const entry of entries) {
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(entry.normalized, from);
      if (index < 0) break;
      occurrences.push({ category: entry.category, index, suffix: text.slice(index + entry.normalized.length) });
      from = index + entry.normalized.length;
    }
  }
  return occurrences.sort((a, b) => a.index - b.index || b.category.length - a.category.length);
}

function isBlockedCategorySuffix(suffix: string): boolean {
  return suffix.startsWith("の") || suffix.startsWith("解約");
}

function isDesignationSuffix(suffix: string): boolean {
  return CATEGORY_DESIGNATION_SUFFIXES.some((candidate) => suffix.startsWith(candidate));
}

/** Find a category that the speaker explicitly used as a classification. */
export function findCategoryDesignation(text: string, config: CategoryConfig): string | null {
  const normalized = text.normalize("NFKC");
  const alternation = categoryAlternation(config);
  if (!alternation) return null;

  const candidates: { category: string; index: number }[] = [];
  const labeled = new RegExp(`(?:カテゴリ|大分類)\\s*(?:は|を|=|:)\\s*(${alternation})`, "g");
  for (const match of normalized.matchAll(labeled)) {
    const category = categoryFromNormalized(match[1] ?? "", config);
    if (category && match.index !== undefined) {
      candidates.push({ category, index: match.index });
    }
  }

  const imperative = new RegExp(`(${alternation})(?:に分類|にして)`, "g");
  for (const match of normalized.matchAll(imperative)) {
    const category = categoryFromNormalized(match[1] ?? "", config);
    if (category && match.index !== undefined) {
      candidates.push({ category, index: match.index });
    }
  }

  const segmentPattern = /[^、。，,・\s]+/g;
  for (const segmentMatch of normalized.matchAll(segmentPattern)) {
    const segment = segmentMatch[0] ?? "";
    const segmentStart = segmentMatch.index ?? 0;
    const occurrences = categoryOccurrences(segment, config);
    const designated = occurrences.filter((occurrence) => isDesignationSuffix(occurrence.suffix));
    if (!designated.length) continue;

    const first = occurrences[0];
    const selected = first && !isBlockedCategorySuffix(first.suffix) ? first : designated[0];
    if (selected) candidates.push({ category: selected.category, index: segmentStart + selected.index });
  }

  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]?.category ?? null;
}

/** Normalize every category crossing the application boundary to the fixed list. */
export function normalizeExpenseCategory(value: unknown, config: CategoryConfig): string {
  const normalized = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  return categoryFromNormalized(normalized, config)
    ?? canonicalCategory("その他", config)
    ?? "その他";
}

export function normalizeExpenseMemo(content: string, category: string | null): string {
  const memo = content.trim();
  if (!memo) return category ? `${category}の支出` : "支出";
  if (category && memo === category) return `${memo}を購入`;
  if (/^[\p{L}\p{N}ー・]+$/u.test(memo) && !/(代|費|購入|課金|支払|買|食|飲)/.test(memo)) {
    return `${memo}を購入`;
  }
  return memo;
}

/** Limit only the confirmation-card projection; the stored memo remains unchanged. */
export function truncateExpenseMemoForDisplay(content: string, max = 200): string {
  const chars = [...content];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : content;
}

function cleanCorrectionValue(value: string): string {
  return value
    .trim()
    .replace(/^[：:＝=\s]+/, "")
    .replace(/[、。，,・]+$/, "")
    .trim();
}

function plannedWords(config: CategoryConfig): string[] {
  return (config.plannedWords ?? [])
    .map((word) => word.normalize("NFKC").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function savingsWords(config: CategoryConfig): string[] {
  return (config.savingsWords ?? [])
    .map((word) => word.normalize("NFKC").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

/** Find the deterministic words that declare a purchase was planned. */
export function findPlannedPurchaseDesignation(text: string, config: CategoryConfig): boolean {
  const normalized = text.normalize("NFKC");
  return plannedWords(config).some((word) => normalized.includes(word));
}

/** Find a deterministic declaration that the purchase was paid from savings. */
export function findPaidFromSavings(text: string, config: CategoryConfig): boolean {
  const normalized = text.normalize("NFKC");
  return savingsWords(config).some((word) => normalized.includes(word));
}

/** Accept only a standalone savings declaration when cancelling a pending card. */
export function isStandaloneSavingsDeclaration(text: string, config: CategoryConfig): boolean {
  const normalized = text
    .normalize("NFKC")
    .trim()
    .replace(/^[。、！？!?]+|[。、！？!?]+$/g, "")
    .trim();
  const words = savingsWords(config);
  if (!normalized || !words.length) return false;
  const pattern = new RegExp(`^(?:${words.map(escapeRegExp).join("|")})(?:です|でした|だよ|だ|ね|よ)?$`);
  return pattern.test(normalized);
}

export type SavingsSuppressionResult<T> = {
  events: T[];
  suppressed: boolean;
};

/** Suppress one complete purchase paid from savings while retaining other actionable events. */
export function dropExpensesPaidFromSavings<T extends ExpenseCandidateEventLike>(events: T[], paidFromSavings: boolean): SavingsSuppressionResult<T> {
  const expenseCandidates = events.filter((event) => event.type === "expense_candidate");
  const suppressed = paidFromSavings && expenseCandidates.length === 1 && isExpenseCandidateComplete(expenseCandidates[0]);
  if (!suppressed) return { events, suppressed: false };
  return {
    events: events.filter((event) => event.type !== "expense_candidate" && !(event.type === "chat_reply" && !event.request_guidance)),
    suppressed: true
  };
}

/** Remove every planned-purchase declaration before the existing correction parser sees the rest. */
export function splitPlannedCorrection(text: string, config: CategoryConfig): { planned: boolean; rest: string } {
  const normalized = text.normalize("NFKC");
  const words = plannedWords(config);
  if (!words.length) return { planned: false, rest: normalized.trim() };
  const pattern = new RegExp(words.map(escapeRegExp).join("|"), "g");
  const planned = pattern.test(normalized);
  pattern.lastIndex = 0;
  const rest = normalized
    .replace(pattern, "")
    .replace(/^[\s、。，,・]+|[\s、。，,・]+$/g, "")
    .trim();
  return { planned, rest };
}

export function isPlannedPayload(payload: Record<string, unknown>): boolean {
  return Number(payload.planned) === 1;
}

function correctionField(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  const value = match?.[1] ? cleanCorrectionValue(match[1]) : "";
  return value || undefined;
}

/** Parse the unambiguous parts of an expense correction without calling an AI. */
export function parseExpenseCorrection(text: string, config: CategoryConfig): ExpenseCorrection {
  const normalized = text.normalize("NFKC").trim();
  if (!normalized) return {};

  const correction: ExpenseCorrection = {};
  const category = findCategoryDesignation(normalized, config);
  if (category) correction.category = category;

  const memo = correctionField(normalized, /(?:品物|商品|小分類)\s*(?:は|を|=|:)\s*([^、。，,・]+)/);
  if (memo) correction.memo = memo;

  const explicitStore = correctionField(normalized, /(?:店|店舗)\s*(?:は|を|=|:)\s*([^、。，,・]+)/);
  if (explicitStore) {
    correction.store = explicitStore;
  } else {
    const purchaseStore = correctionField(normalized, /(?:^|[、。，,・\s])([^、。，,・\s]+?)\s*で(?:買った|購入した|購入|買い)/);
    const atStore = correctionField(normalized, /(?:^|[、。，,・\s])([^、。，,・\s]+?)\s*にて/);
    const inferredStore = purchaseStore ?? atStore;
    if (inferredStore && !categoryFromNormalized(inferredStore, config)) {
      correction.store = inferredStore;
    }
  }

  const amount = normalized.match(/(?:¥|￥)?\s*(\d[\d,]*)\s*円/);
  if (amount?.[1]) {
    const parsedAmount = Number(amount[1].replace(/,/g, ""));
    if (Number.isSafeInteger(parsedAmount) && parsedAmount > 0) correction.amount = parsedAmount;
  }

  return correction;
}

export function hasCorrectionCue(text: string): boolean {
  return CORRECTION_CUE.test(text.normalize("NFKC"));
}

/** Resolve the five deterministic target branches before any classification AI call. */
export function resolveCorrectionTarget(input: CorrectionTargetInput): CorrectionTargetDecision {
  if (input.isReply && input.referencedPending) return "reply_match";
  if (input.isReply && input.referencedBotExpenseCard) return "reply_expired_or_processed";
  if (!input.isReply && input.pendingCount === 1) return "single_pending";
  if (!input.isReply && input.pendingCount > 1) return "ambiguous";
  return "no_pending";
}

function truncateDisplay(value: unknown, max = 40): string {
  const text = String(value ?? "").trim() || "支出";
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, Math.max(0, max - 1)).join("")}…` : text;
}

function formatExpenseDay(value: string): string {
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${Number(match[2])}/${Number(match[3])}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).format(date);
}

export function formatSavingsStatus(rows: readonly SavingsStatusRow[]): string {
  if (!rows.length) return "貯金の積立: なし";
  return [
    "貯金の積立（名前ごとの累計・全期間・最新50名称）",
    ...rows.map((row) => {
      const memo = String(row.memo ?? "").trim() || "名前なし";
      const total = Number(row.total ?? 0).toLocaleString("ja-JP");
      const count = Math.max(0, Math.round(Number(row.n ?? 0)));
      const last = row.last ? formatExpenseDay(row.last) : "不明";
      return `${memo}: ${total}円（${count}回・最終 ${last}）`;
    })
  ].join("／");
}

function expenseDetail(row: ExpenseLikeRow, category: string): string {
  const memo = truncateDisplay(row.memo, 40);
  const store = row.store ? ` @ ${truncateDisplay(row.store, 40)}` : "";
  return `  - ${formatExpenseDay(row.spent_at)} ${memo}${store} ${Number(row.amount).toLocaleString("ja-JP")}円`;
}

function groupedExpenses(rows: readonly ExpenseLikeRow[], config: CategoryConfig): { category: string; rows: ExpenseLikeRow[] }[] {
  const groups = new Map<string, ExpenseLikeRow[]>();
  for (const row of rows) {
    const category = normalizeExpenseCategory(row.category, config);
    const group = groups.get(category) ?? [];
    group.push(row);
    groups.set(category, group);
  }
  const entries = normalizedCategoryEntries(config);
  return entries
    .map((entry) => ({ category: entry.value, rows: groups.get(entry.value) ?? [] }))
    .filter((group) => group.rows.length > 0);
}

export function buildExpenseHierarchyParts(
  rows: readonly ExpenseLikeRow[],
  config: CategoryConfig,
  perCategoryLimit?: number,
  summary?: ExpenseSummary
): ExpenseContentParts {
  const total = summary?.total ?? rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const summaryTotals = new Map<string, number>();
  for (const entry of summary?.byCategory ?? []) {
    const category = normalizeExpenseCategory(entry.category, config);
    summaryTotals.set(category, (summaryTotals.get(category) ?? 0) + Number(entry.total || 0));
  }
  const grouped = new Map(groupedExpenses(rows, config).map((group) => [group.category, group.rows]));
  const sections = normalizedCategoryEntries(config)
    .map(({ value: category }) => ({
      category,
      rows: grouped.get(category) ?? [],
      subtotal: summaryTotals.has(category)
        ? summaryTotals.get(category) ?? 0
        : (grouped.get(category) ?? []).reduce((sum, row) => sum + Number(row.amount || 0), 0)
    }))
    .filter((group) => group.rows.length > 0 || summaryTotals.has(group.category))
    .map(({ category, rows: categoryRows, subtotal }) => {
    const limit = perCategoryLimit === undefined ? categoryRows.length : Math.max(0, perCategoryLimit);
    const details = categoryRows.slice(0, limit).map((row) => expenseDetail(row, category));
    return {
      category,
      header: `■ ${category} ${subtotal.toLocaleString("ja-JP")}円`,
      details,
      overflow: Math.max(0, categoryRows.length - details.length)
    };
  });
  return {
    header: [`合計: ${total.toLocaleString("ja-JP")}円`],
    sections
  };
}

export function formatExpenseHierarchy(rows: readonly ExpenseLikeRow[], config: CategoryConfig): string {
  const parts = buildExpenseHierarchyParts(rows, config);
  const lines = [...parts.header];
  for (const section of parts.sections ?? []) {
    lines.push(section.header, ...section.details);
    if (section.overflow > 0) lines.push(`  - 他${section.overflow}件`);
  }
  return lines.join("\n");
}

function flattenLines(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => String(value).split("\n")).filter((line) => line.length > 0);
}

function contentLength(value: string): number {
  return [...value].length;
}

function renderContentParts(
  parts: ExpenseContentParts,
  selectedDetails: Set<string>,
  selectedOverflow: Set<number>,
  globalOverflow: number
): string {
  const lines = [...flattenLines(parts.header)];
  let sectionIndex = 0;
  for (const section of parts.sections ?? []) {
    lines.push(section.header);
    section.details.forEach((detail, detailIndex) => {
      const key = `${sectionIndex}:${detailIndex}`;
      if (selectedDetails.has(key)) lines.push(detail);
    });
    if (section.overflow > 0 && selectedOverflow.has(sectionIndex)) {
      lines.push(`  - 他${section.overflow}件`);
    }
    sectionIndex += 1;
  }
  lines.push(...flattenLines(parts.details).filter((detail, index) => selectedDetails.has(`top:${index}`)));
  if (globalOverflow > 0) lines.push(`  - 他${globalOverflow}件`);
  return lines.join("\n");
}

/**
 * Fit Discord content at line boundaries while retaining every fixed header and
 * category subtotal. The object form is used by expense reports; the array form
 * keeps the helper convenient for ordinary fixed-content messages and tests.
 */
export function fitDiscordContent(parts: ExpenseContentParts | readonly string[], max = 1900): string {
  const limit = Math.max(1, Math.floor(max));
  let structured: ExpenseContentParts;
  if (Array.isArray(parts)) {
    const lines = flattenLines(parts);
    const original = lines.join("\n");
    if (contentLength(original) <= limit) return original;
    const detailLines = lines.filter((line) => /^\s*-\s/.test(line) || /^\s*他\d+件/.test(line));
    const header = lines.filter((line) => !/^\s*-\s/.test(line) && !/^\s*他\d+件/.test(line));
    structured = detailLines.length ? { header, details: detailLines } : { header: lines };
  } else {
    structured = parts as ExpenseContentParts;
  }

  const selectedDetails = new Set<string>();
  const selectedOverflow = new Set<number>();
  const candidates: { key: string; overflow: boolean; index: number; count: number }[] = [];
  let detailCount = 0;
  (structured.sections ?? []).forEach((section, sectionIndex) => {
    section.details.forEach((_, detailIndex) => {
      candidates.push({ key: `${sectionIndex}:${detailIndex}`, overflow: false, index: detailCount, count: 1 });
      detailCount += 1;
    });
    if (section.overflow > 0) {
      candidates.push({ key: `overflow:${sectionIndex}`, overflow: true, index: detailCount, count: section.overflow });
      detailCount += section.overflow;
    }
  });
  (structured.details ?? []).forEach((_, detailIndex) => {
    candidates.push({ key: `top:${detailIndex}`, overflow: false, index: detailCount, count: 1 });
    detailCount += 1;
  });

  const renderCandidate = (candidate: { key: string; overflow: boolean; index: number; count: number }, globalOverflow: number): string => {
    if (candidate.overflow) selectedOverflow.add(Number(candidate.key.split(":")[1]));
    else selectedDetails.add(candidate.key);
    const output = renderContentParts(structured, selectedDetails, selectedOverflow, globalOverflow);
    if (contentLength(output) <= limit) return output;
    if (candidate.overflow) selectedOverflow.delete(Number(candidate.key.split(":")[1]));
    else selectedDetails.delete(candidate.key);
    return "";
  };

  let omitted = detailCount;
  for (const candidate of candidates) {
    const remainingAfter = omitted - candidate.count;
    const globalOverflow = remainingAfter > 0 ? remainingAfter : 0;
    const output = renderCandidate(candidate, globalOverflow);
    if (!output) break;
    omitted = remainingAfter;
  }

  let output = renderContentParts(structured, selectedDetails, selectedOverflow, omitted);
  if (contentLength(output) <= limit) return output;

  // A normal expense header is well below Discord's limit. If a caller supplies
  // an unusually long fixed line, retain complete lines rather than cutting text.
  const lines = output.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line].join("\n");
    if (contentLength(candidate) > limit) break;
    kept.push(line);
  }
  output = kept.join("\n");
  return output;
}
