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
  resolveCorrectionTarget,
  SCOLD_LEVEL2_MIN_AMOUNT,
  scoldLevel,
  type CategoryConfig
} from "../src/expense-logic.ts";
import {
  formatRequestList,
  renderIntakeMessage,
  resolveRequestAnswerTarget,
  resolveRequestCue,
  selectIntakeQuestions,
  REQUEST_DETAILS_UPDATE_SQL
} from "../src/request-logic.ts";
import { expenseAiComment } from "../src/expense-comment.ts";

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

test("機能要望の決定論トリガーは取消・先頭・含有の順で解決する", () => {
  assert.deepEqual(resolveRequestCue("要望：カレンダー連携が欲しい"), {
    kind: "new",
    summary: "カレンダー連携が欲しい",
    cueSpan: { start: 0, end: 3 }
  });
  assert.deepEqual(resolveRequestCue("機能要望です。レシートを読めるようにしてほしい"), {
    kind: "new",
    summary: "レシートを読めるようにしてほしい",
    cueSpan: { start: 0, end: 7 }
  });
  assert.equal(resolveRequestCue("要望なし").kind, "cancel");
  assert.equal(resolveRequestCue("さっきの要望取り消し").kind, "cancel");
  assert.deepEqual(resolveRequestCue("要望取り消し機能が欲しい"), {
    kind: "new",
    summary: "要望取り消し機能が欲しい",
    cueSpan: null
  });
  assert.equal(resolveRequestCue("要望書を会社に出した").kind, "none");
  assert.equal(resolveRequestCue("今日は特に要望ない").kind, "none");
  assert.equal(resolveRequestCue("要望はないけどこの機能は便利").kind, "none");
  assert.equal(resolveRequestCue("要望：").summary, "");
});

test("聞き取り質問は不足分を優先順で最大2問、AI不正は0問", () => {
  assert.deepEqual(selectIntakeQuestions({ scene: false, pain: false, outcome: false }), ["scene", "pain"]);
  assert.deepEqual(selectIntakeQuestions({ scene: true, pain: true, outcome: false }), ["outcome"]);
  assert.deepEqual(selectIntakeQuestions({ scene: true, pain: true, outcome: true }), []);
  assert.deepEqual(selectIntakeQuestions(null), []);
  assert.deepEqual(selectIntakeQuestions({ scene: false, pain: "yes", outcome: false } as unknown as { scene: boolean; pain: boolean; outcome: boolean }), []);
});

test("要望回答の対象決定はリプライ・bot投稿・直答の条件を分ける", () => {
  const now = "2026-09-06T12:00:00+09:00";
  const active = {
    id: 1,
    requestedBy: "user-1",
    channelId: "channel-1",
    intakeMessageId: "intake-1",
    intakeAt: "2026-09-06T11:40:00+09:00",
    pendingQuestions: "scene,pain"
  };
  assert.equal(resolveRequestAnswerTarget({
    isReply: true,
    replyMessageId: "intake-1",
    referencedMessageIsBotIntakePost: false,
    candidates: [active],
    actorId: "user-1",
    channelId: "channel-1",
    now
  }).kind, "reply_match");
  assert.equal(resolveRequestAnswerTarget({
    isReply: true,
    replyMessageId: "old-intake",
    referencedMessageIsBotIntakePost: true,
    candidates: [],
    actorId: "user-1",
    channelId: "channel-1",
    now
  }).kind, "reply_missing");
  assert.equal(resolveRequestAnswerTarget({
    isReply: false,
    referencedMessageIsBotIntakePost: false,
    candidates: [active],
    actorId: "user-1",
    channelId: "channel-1",
    now
  }).kind, "direct_match");
  assert.equal(resolveRequestAnswerTarget({
    isReply: false,
    referencedMessageIsBotIntakePost: false,
    candidates: [{ ...active, intakeAt: "2026-09-06T11:29:00+09:00" }],
    actorId: "user-1",
    channelId: "channel-1",
    now
  }).kind, "none");
  assert.equal(resolveRequestAnswerTarget({
    isReply: false,
    referencedMessageIsBotIntakePost: false,
    candidates: [active, { ...active, id: 2, intakeMessageId: "intake-2" }],
    actorId: "user-1",
    channelId: "channel-1",
    now
  }).kind, "direct_ambiguous");
});

test("受付投稿は概要を表示だけ短縮し、固定質問と案内を残す", () => {
  const original = "概要\n" + "あ".repeat(2_000);
  const output = renderIntakeMessage(original, ["scene", "pain"]);
  assert.ok([...output].length <= 1_900);
  assert.match(output, /要望として受け付けました。/);
  assert.match(output, /…/);
  assert.match(output, /どの場面・どのチャンネルで使いたいですか？/);
  assert.match(output, /今はどこが不便ですか？/);
  assert.match(output, /答えはこのメッセージにリプライで。任意です/);
  assert.match(renderIntakeMessage("概要", []), /詳細が必要になったら聞きますね/);
});

test("要望一覧は状態語と60字表示をfitする", () => {
  const output = formatRequestList([
    { id: 1, status: "open", summary: "あ".repeat(80) },
    { id: 2, status: "in_progress", summary: "対応中の要望" },
    { id: 3, status: "done", summary: "完了した要望" },
    { id: 4, status: "declined", summary: "見送りの要望" }
  ]);
  assert.ok([...output].length <= 1_900);
  assert.match(output, /#1 \[受付\]/);
  assert.match(output, /#2 \[対応中\]/);
  assert.match(output, /#3 \[対応済み\]/);
  assert.match(output, /#4 \[見送り\]/);
  assert.match(output, /…/);
});

test("要望詳細UPDATEは本人・チャンネル・openをWHEREで固定する", () => {
  assert.match(REQUEST_DETAILS_UPDATE_SQL, /details = CASE WHEN details = '' THEN \? ELSE details \|\| char\(10\) \|\| \? END/);
  assert.match(REQUEST_DETAILS_UPDATE_SQL, /pending_questions = ''/);
  assert.match(REQUEST_DETAILS_UPDATE_SQL, /WHERE id = \? AND requested_by = \? AND channel_id = \? AND status = 'open'/);
});

test("分類指定表現は固定ルールで大分類を拾う", () => {
  assert.equal(findCategoryDesignation("その他で電池買った 220円", categoryConfig), "その他");
  assert.equal(findCategoryDesignation("イオンで牛乳 300円", categoryConfig), null);
  assert.equal(findCategoryDesignation("カテゴリは雑費、電池220円", categoryConfig), "雑費");
  assert.equal(findCategoryDesignation("食費っていうか雑費で", categoryConfig), "食費");
  assert.equal(findCategoryDesignation("趣味の店で買った500円", categoryConfig), null);
  assert.equal(findCategoryDesignation("サブスク解約で3000円浮いた", categoryConfig), null);
  assert.equal(findCategoryDesignation("今日は趣味で買った", categoryConfig), "趣味");
  assert.equal(findCategoryDesignation("ゲームで課金3000円", categoryConfig), "趣味");
});

test("旧分類別名は正規化時だけ新分類へ対応付ける", () => {
  assert.equal(normalizeExpenseCategory("ゲーム", categoryConfig), "趣味");
  assert.equal(normalizeExpenseCategory("書籍", categoryConfig), "趣味");
  assert.equal(normalizeExpenseCategory("交通", categoryConfig), "交通費");
  assert.equal(normalizeExpenseCategory("不明", categoryConfig), "その他");
  assert.equal(normalizeExpenseCategory(null, categoryConfig), "その他");
  assert.equal(normalizeExpenseCategory("食費", categoryConfig), "食費");
});

test("支出訂正の決定論パーサー", () => {
  assert.deepEqual(parseExpenseCorrection("雑費にして", categoryConfig), { category: "雑費" });
  assert.deepEqual(parseExpenseCorrection("書籍にして", categoryConfig), { category: "趣味" });
  assert.deepEqual(parseExpenseCorrection("店はまいばすけっと", categoryConfig), { store: "まいばすけっと" });
  assert.deepEqual(parseExpenseCorrection("500円だった", categoryConfig), { amount: 500 });
  assert.deepEqual(parseExpenseCorrection("", categoryConfig), {});
  assert.deepEqual(parseExpenseCorrection("雑費にして、店はまいばすけっと、品物は電池、500円", categoryConfig), {
    category: "雑費",
    store: "まいばすけっと",
    memo: "電池",
    amount: 500
  });
});

test("趣味の支出だけ金額で叱り尺度を決める", () => {
  assert.equal(SCOLD_LEVEL2_MIN_AMOUNT, 10_000);
  assert.equal(scoldLevel("食費", 50_000), 0);
  assert.equal(scoldLevel("サブスク", 50_000), 0);
  assert.equal(scoldLevel("交際費", 50_000), 0);
  assert.equal(scoldLevel("趣味", 2_000), 1);
  assert.equal(scoldLevel("趣味", 9_999), 1);
  assert.equal(scoldLevel("趣味", SCOLD_LEVEL2_MIN_AMOUNT), 2);
  assert.equal(scoldLevel(normalizeExpenseCategory("ゲーム", categoryConfig), 15_000), 2);
});

test("支出コメント生成は尺度0でAIを呼ばず、尺度1・2で1回だけ呼ぶ", async () => {
  let calls = 0;
  const loadPersona = async (): Promise<string> => "テスト用ユウカ";
  const generate = async (prompt: string, temperature: number): Promise<string> => {
    calls += 1;
    assert.ok(prompt.length > 0);
    assert.equal(temperature, 0.9);
    return "記録できる形に整えておきます。";
  };

  await expenseAiComment(0, 2_000, "食費", "昼食", null, loadPersona, generate);
  assert.equal(calls, 0);
  await expenseAiComment(1, 2_000, "趣味", "本", null, loadPersona, generate);
  assert.equal(calls, 1);
  await expenseAiComment(2, 10_000, "趣味", "ゲーム機", "店", loadPersona, generate);
  assert.equal(calls, 2);
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
  const output = formatExpenseHierarchy(rows, categoryConfig);
  assert.match(output, /合計: 2,900円/);
  assert.match(output, /■ 食費 680円/);
  assert.match(output, /  - 9\/5 牛乳とパン @ イオン 680円/);
  assert.match(output, /■ 雑費 2,000円/);
  assert.match(output, /■ 趣味 220円/);
  assert.ok(output.indexOf("■ 食費") < output.indexOf("■ 雑費"));
  assert.ok(output.indexOf("■ 雑費") < output.indexOf("■ 趣味"));
});

test("旧分類別名は集計と階層表示で正規化先に合流する", () => {
  const rows = [
    { amount: 100, category: "交通", memo: "電車", store: null, spent_at: "2026-09-05T12:00:00+09:00" },
    { amount: 200, category: "交通費", memo: "バス", store: null, spent_at: "2026-09-05T12:00:00+09:00" },
    { amount: 150, category: "ゲーム", memo: "ゲーム課金", store: null, spent_at: "2026-09-05T12:00:00+09:00" },
    { amount: 250, category: "書籍", memo: "本", store: null, spent_at: "2026-09-05T12:00:00+09:00" },
    { amount: 300, category: "趣味", memo: "模型", store: null, spent_at: "2026-09-05T12:00:00+09:00" }
  ];
  const output = formatExpenseHierarchy(rows, categoryConfig);
  assert.match(output, /■ 交通費 300円/);
  assert.match(output, /■ 趣味 700円/);
  assert.equal(output.match(/■ 交通費/g)?.length, 1);
  assert.equal(output.match(/■ 趣味/g)?.length, 1);
});

test("一覧は明細10件、合計と小計は範囲全体", () => {
  const allRows = [
    ...Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      amount: 100,
      category: "食費",
      memo: `食費${index}`,
      store: null,
      spent_at: "2026-09-05T12:00:00+09:00"
    })),
    { id: 11, amount: 500, category: "雑費", memo: "範囲全体の雑費", store: null, spent_at: "2026-09-04T12:00:00+09:00" },
    { id: 12, amount: 700, category: "ゲーム", memo: "範囲全体の一覧外", store: null, spent_at: "2026-09-03T12:00:00+09:00" }
  ];
  const visibleRows = allRows.slice(0, 10);
  const parts = buildExpenseHierarchyParts(visibleRows, categoryConfig, undefined, {
    total: 2_200,
    byCategory: [
      { category: "食費", total: 1_000 },
      { category: "雑費", total: 500 },
      { category: "ゲーム", total: 700 }
    ]
  });
  const output = fitDiscordContent(parts, 1900);
  assert.match(output, /合計: 2,200円/);
  assert.match(output, /■ 食費 1,000円/);
  assert.match(output, /■ 雑費 500円/);
  assert.match(output, /■ 趣味 700円/);
  assert.equal(output.split("\n").filter((line) => line.startsWith("  - ")).length, 10);
  assert.doesNotMatch(output, /範囲全体の雑費|範囲全体の一覧外/);
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
  const parts = buildExpenseHierarchyParts(rows, categoryConfig);
  const output = fitDiscordContent(parts, 1900);
  assert.ok([...output].length <= 1900);
  assert.match(output, /合計: 4,000円/);
  assert.match(output, /■ 食費 2,000円/);
  assert.match(output, /■ 雑費 2,000円/);
  assert.match(output, /他\d+件/);
  assert.ok(!output.split("\n").some((line) => line.length > 0 && !line.startsWith("  - ") && !line.startsWith("■") && !line.startsWith("合計:")));
});
