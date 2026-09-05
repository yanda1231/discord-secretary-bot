import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExpenseHierarchyParts,
  findCategoryDesignation,
  fitDiscordContent,
  formatExpenseHierarchy,
  hasCorrectionCue,
  normalizeExpenseCategory,
  parseExpenseCorrection,
  resolveCorrectionTarget
} from "../src/expense-logic.ts";

const categories = ["食費", "雑費", "日用品", "交通費", "交際費", "医療費", "趣味", "サブスク", "住居", "その他"];

test("分類指定表現は固定ルールで大分類を拾う", () => {
  assert.equal(findCategoryDesignation("その他で電池買った 220円", categories), "その他");
  assert.equal(findCategoryDesignation("イオンで牛乳 300円", categories), null);
  assert.equal(findCategoryDesignation("カテゴリは雑費、電池220円", categories), "雑費");
  assert.equal(findCategoryDesignation("食費っていうか雑費で", categories), "食費");
  assert.equal(findCategoryDesignation("趣味の店で買った500円", categories), null);
  assert.equal(findCategoryDesignation("サブスク解約で3000円浮いた", categories), null);
  assert.equal(findCategoryDesignation("今日は趣味で買った", categories), "趣味");
});

test("一覧外の大分類はその他へ丸める", () => {
  assert.equal(normalizeExpenseCategory("ゲーム", categories), "その他");
  assert.equal(normalizeExpenseCategory(null, categories), "その他");
  assert.equal(normalizeExpenseCategory("食費", categories), "食費");
});

test("支出訂正の決定論パーサー", () => {
  assert.deepEqual(parseExpenseCorrection("雑費にして", categories), { category: "雑費" });
  assert.deepEqual(parseExpenseCorrection("店はまいばすけっと", categories), { store: "まいばすけっと" });
  assert.deepEqual(parseExpenseCorrection("500円だった", categories), { amount: 500 });
  assert.deepEqual(parseExpenseCorrection("", categories), {});
  assert.deepEqual(parseExpenseCorrection("雑費にして、店はまいばすけっと、品物は電池、500円", categories), {
    category: "雑費",
    store: "まいばすけっと",
    memo: "電池",
    amount: 500
  });
});

test("訂正の合図と対象決定の5分岐", () => {
  assert.equal(hasCorrectionCue("雑費にして"), true);
  assert.equal(hasCorrectionCue("今日は疲れた"), false);
  assert.equal(resolveCorrectionTarget({ isReply: true, referencedPending: true, referencedBotExpenseCard: false, pendingCount: 0 }), "reply_match");
  assert.equal(resolveCorrectionTarget({ isReply: true, referencedPending: false, referencedBotExpenseCard: true, pendingCount: 0 }), "reply_expired_or_processed");
  assert.equal(resolveCorrectionTarget({ isReply: false, referencedPending: false, referencedBotExpenseCard: false, pendingCount: 1 }), "single_pending");
  assert.equal(resolveCorrectionTarget({ isReply: false, referencedPending: false, referencedBotExpenseCard: false, pendingCount: 0 }), "no_pending");
  assert.equal(resolveCorrectionTarget({ isReply: false, referencedPending: false, referencedBotExpenseCard: false, pendingCount: 2 }), "ambiguous");
});

test("大分類順の階層表示と一覧外の集約", () => {
  const rows = [
    { id: 1, amount: 680, category: "食費", memo: "牛乳とパン", store: "イオン", spent_at: "2026-09-05T12:00:00+09:00" },
    { id: 2, amount: 220, category: "ゲーム", memo: "電池", store: "ダイソー", spent_at: "2026-09-04T12:00:00+09:00" },
    { id: 3, amount: 2000, category: "雑費", memo: "雑貨", store: null, spent_at: "2026-09-03T12:00:00+09:00" }
  ];
  const output = formatExpenseHierarchy(rows, categories);
  assert.match(output, /合計: 2,900円/);
  assert.match(output, /■ 食費 680円/);
  assert.match(output, /  - 9\/5 牛乳とパン @ イオン 680円/);
  assert.match(output, /■ 雑費 2,000円/);
  assert.match(output, /■ その他 220円/);
  assert.ok(output.indexOf("■ 食費") < output.indexOf("■ 雑費"));
  assert.ok(output.indexOf("■ 雑費") < output.indexOf("■ その他"));
});

test("Discord文字数境界は明細を行単位で省略する", () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    amount: 100,
    category: index % 2 ? "食費" : "雑費",
    memo: `${index}${"あ".repeat(39)}`,
    store: "い".repeat(40),
    spent_at: "2026-09-05T12:00:00+09:00"
  }));
  const parts = buildExpenseHierarchyParts(rows, categories);
  const output = fitDiscordContent(parts, 1900);
  assert.ok([...output].length <= 1900);
  assert.match(output, /合計: 4,000円/);
  assert.match(output, /■ 食費 2,000円/);
  assert.match(output, /■ 雑費 2,000円/);
  assert.match(output, /他\d+件/);
  assert.ok(!output.split("\n").some((line) => line.length > 0 && !line.startsWith("  - ") && !line.startsWith("■") && !line.startsWith("合計:")));
});
