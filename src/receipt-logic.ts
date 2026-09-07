import { normalizeExpenseCategory, type CategoryConfig } from "./expense-logic.ts";

export type ReceiptAttachment = {
  url: string;
  content_type?: string | null;
  size?: number | null;
};

export type ReceiptItem = {
  name: string;
  price: number | null;
};

export type ParsedReceipt = {
  store: string | null;
  total: number;
  date: string | null;
  items: ReceiptItem[];
  category: string;
  truncated: boolean;
};

export type ReceiptParseResult =
  | { kind: "not_receipt" }
  | { kind: "unreadable" }
  | { kind: "ok"; receipt: ParsedReceipt };

export type ReceiptExpensePayload = {
  amount: number;
  category: string;
  item: string;
  memo: string;
  store: string;
  spent_at: string;
};

export type ReceiptPayloadOptions = {
  fallbackSpentAt: string;
  categoryHint?: string | null;
  normalizeMemo: (content: string, category: string | null) => string;
};

const RECEIPT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif"
]);
const RECEIPT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const RECEIPT_MAX_ITEMS = 30;
const RECEIPT_MAX_TEXT = 100;

function truncateText(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

function isAllowedReceiptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && RECEIPT_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isAllowedReceiptAttachment(attachment: ReceiptAttachment): boolean {
  const mimeType = typeof attachment.content_type === "string" ? attachment.content_type.toLowerCase() : "";
  return isAllowedReceiptUrl(attachment.url)
    && RECEIPT_MIME_TYPES.has(mimeType)
    && typeof attachment.size === "number"
    && Number.isFinite(attachment.size)
    && attachment.size >= 0
    && attachment.size <= RECEIPT_MAX_BYTES;
}

/** Select the first accepted image; later images are deliberately ignored. */
export function selectReceiptAttachment(attachments: readonly ReceiptAttachment[] | null | undefined): ReceiptAttachment | null {
  return attachments?.find(isAllowedReceiptAttachment) ?? null;
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

function parseItemPrice(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseItems(value: unknown): { items: ReceiptItem[]; truncated: boolean } {
  if (!Array.isArray(value)) return { items: [], truncated: false };
  const truncated = value.length > RECEIPT_MAX_ITEMS;
  const items = value.slice(0, RECEIPT_MAX_ITEMS).flatMap((candidate): ReceiptItem[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const name = (candidate as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) return [];
    return [{
      name: truncateText(name.trim(), RECEIPT_MAX_TEXT),
      price: parseItemPrice((candidate as { price?: unknown }).price)
    }];
  });
  return { items, truncated };
}

/** Validate and normalize Gemini's receipt JSON without side effects. */
export function parseReceiptResponse(raw: string, config: CategoryConfig): ReceiptParseResult {
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return { kind: "unreadable" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { kind: "unreadable" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unreadable" };
  const data = parsed as Record<string, unknown>;
  if (data.is_receipt === false) return { kind: "not_receipt" };
  if (data.is_receipt !== true) return { kind: "unreadable" };

  const total = data.total;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0) return { kind: "unreadable" };

  const store = typeof data.store === "string" && data.store.trim()
    ? truncateText(data.store.trim(), RECEIPT_MAX_TEXT)
    : null;
  const { items, truncated } = parseItems(data.items);
  return {
    kind: "ok",
    receipt: {
      store,
      total,
      date: isValidDate(data.date) ? data.date : null,
      items,
      category: normalizeExpenseCategory(data.category, config),
      truncated
    }
  };
}

export function buildReceiptExpensePayload(
  receipt: ParsedReceipt,
  options: ReceiptPayloadOptions
): ReceiptExpensePayload {
  const category = options.categoryHint?.trim() || receipt.category;
  const item = receipt.truncated
    ? "レシート（30点以上）"
    : receipt.items.length === 0
      ? "レシート（品目読み取れず）"
      : receipt.items.length === 1
        ? receipt.items[0].name
        : `レシート（${receipt.items.length}点）`;
  const memo = receipt.items
    .map((entry) => entry.price === null ? entry.name : `${entry.name} ${entry.price}`)
    .join("、");
  return {
    amount: receipt.total,
    category,
    item,
    memo: options.normalizeMemo(memo || item, category),
    store: receipt.store ?? "",
    spent_at: receipt.date ?? options.fallbackSpentAt
  };
}
