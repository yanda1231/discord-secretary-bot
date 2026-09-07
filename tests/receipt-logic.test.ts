import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReceiptExpensePayload,
  parseReceiptResponse,
  selectReceiptAttachment
} from "../src/receipt-logic.ts";
import {
  normalizeExpenseMemo,
  truncateExpenseMemoForDisplay,
  type CategoryConfig
} from "../src/expense-logic.ts";

const categoryConfig: CategoryConfig = {
  categories: ["食費", "雑費", "日用品", "交通費", "交際費", "医療費", "趣味", "サブスク", "住居", "その他"],
  aliases: {
    "交通": "交通費",
    "ゲーム": "趣味",
    "書籍": "趣味",
    "交際": "交際費",
    "医療": "医療費"
  }
};

function parse(value: unknown) {
  return parseReceiptResponse(JSON.stringify(value), categoryConfig);
}

function build(value: unknown, categoryHint: string | null = null) {
  const parsed = parse(value);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") throw new Error("receipt fixture was not readable");
  return buildReceiptExpensePayload(parsed.receipt, {
    fallbackSpentAt: "2026-09-07T10:00:00+09:00",
    categoryHint,
    normalizeMemo: normalizeExpenseMemo
  });
}

test("レシート判定のfalse・欠落・文字列を区別する", () => {
  assert.deepEqual(parse({ is_receipt: false }), { kind: "not_receipt" });
  assert.deepEqual(parse({}), { kind: "unreadable" });
  assert.deepEqual(parse({ is_receipt: "true", total: 100 }), { kind: "unreadable" });
});

test("合計は正の安全な整数だけを採用する", () => {
  for (const total of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(parse({ is_receipt: true, total }), { kind: "unreadable" });
  }
});

test("読み取り結果を既存支出payloadへ変換する", () => {
  assert.deepEqual(build({
    is_receipt: true,
    store: "  イオン  ",
    total: 680,
    date: "2026-09-05",
    items: [{ name: "牛乳", price: 300 }, { name: "パン", price: 380 }],
    category: "交通"
  }), {
    amount: 680,
    category: "交通費",
    item: "レシート（2点）",
    memo: "牛乳 300、パン 380",
    store: "イオン",
    spent_at: "2026-09-05"
  });
});

test("品目31件は30件だけを保存し、切り詰め表示名を使う", () => {
  const items = Array.from({ length: 31 }, (_, index) => ({ name: `品目${index + 1}`, price: index + 1 }));
  const payload = build({ is_receipt: true, total: 31_000, items, category: "食費" });
  assert.equal(payload.item, "レシート（30点以上）");
  assert.match(payload.memo, /品目1 1/);
  assert.match(payload.memo, /品目30 30/);
  assert.doesNotMatch(payload.memo, /品目31 31/);
  assert.equal(payload.memo.split("、").length, 30);
});

test("未知カテゴリはその他、本文指定のcategoryHintを優先する", () => {
  assert.equal(build({ is_receipt: true, total: 100, category: "未知" }).category, "その他");
  assert.equal(build({ is_receipt: true, total: 100, category: "食費" }, "趣味").category, "趣味");
});

test("不正な日付とnullの日付は投稿日へフォールバックする", () => {
  assert.equal(build({ is_receipt: true, total: 100, date: null }).spent_at, "2026-09-07T10:00:00+09:00");
  assert.equal(build({ is_receipt: true, total: 100, date: "2026-99-99" }).spent_at, "2026-09-07T10:00:00+09:00");
});

test("Discord添付は受入条件を満たす先頭1件だけ選ぶ", () => {
  const valid = { url: "https://cdn.discordapp.com/receipts/a.jpg", content_type: "image/jpeg", size: 100 };
  const second = { url: "https://cdn.discordapp.com/receipts/b.png", content_type: "image/png", size: 100 };
  assert.equal(selectReceiptAttachment([
    { ...valid, url: "http://cdn.discordapp.com/receipts/http.jpg" },
    { ...valid, url: "https://example.com/receipts/a.jpg" },
    { ...valid, content_type: "image/gif" },
    { ...valid, size: undefined },
    { ...valid, size: 10 * 1024 * 1024 + 1 },
    valid,
    second
  ]), valid);
  assert.equal(selectReceiptAttachment([{ ...valid, size: undefined }]), null);
});

test("品目空配列でも合計だけのpayloadを作る", () => {
  const payload = build({ is_receipt: true, total: 500, items: [], category: "食費" });
  assert.equal(payload.item, "レシート（品目読み取れず）");
  assert.equal(payload.memo, "レシート（品目読み取れず）");
});

test("表示用メモだけを200文字＋省略記号にする", () => {
  const source = "あ".repeat(201);
  const displayed = truncateExpenseMemoForDisplay(source);
  assert.equal(source.length, 201);
  assert.equal([...displayed].length, 201);
  assert.equal([...displayed].slice(0, 200).join(""), "あ".repeat(200));
  assert.equal([...displayed].at(-1), "…");
});
