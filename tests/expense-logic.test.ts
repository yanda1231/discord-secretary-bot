import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExpenseHierarchyParts,
  dropChatReplyWhenExpenseCard,
  expenseRangeBounds,
  findCategoryDesignation,
  findPlannedPurchaseDesignation,
  fitDiscordContent,
  formatExpenseHierarchy,
  hasCorrectionCue,
  isExpenseCandidateComplete,
  isPlannedPayload,
  normalizeExpenseCategory,
  parseExpenseCorrection,
  parseExpenseMonth,
  resolveCorrectionTarget,
  resolveExpenseRange,
  SCOLD_LEVEL1_MIN_AMOUNT,
  SCOLD_LEVEL2_MIN_AMOUNT,
  SCOLD_LEVEL3_MIN_AMOUNT,
  scoldLevel,
  splitPlannedCorrection,
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
import { expenseAsides, expenseAsidesLevel1, expenseAsidesLevel2, expenseAsidesLevel3, expenseAsidesPlanned } from "../src/yuuka-phrases.ts";

const categoryConfig: CategoryConfig = {
  categories: ["食費", "雑費", "日用品", "交通費", "交際費", "医療費", "趣味", "サブスク", "住居", "その他"],
  aliases: {
    "交通": "交通費",
    "ゲーム": "趣味",
    "書籍": "趣味",
    "交際": "交際費",
    "医療": "医療費"
  },
  plannedWords: ["計画購入", "計画買い", "貯金から", "積立から", "貯めた分", "貯めてた分", "貯めていた分", "予定どおり", "予定通り"]
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

test("計画購入の宣言は本文と訂正の残りを決定論で分ける", () => {
  assert.equal(findPlannedPurchaseDesignation("計画購入 グラボ 45000円", categoryConfig), true);
  assert.equal(findPlannedPurchaseDesignation("貯金からです", categoryConfig), true);
  assert.equal(findPlannedPurchaseDesignation("予定どおりに買った", categoryConfig), true);
  assert.equal(findPlannedPurchaseDesignation("計画購入", categoryConfig), true);
  assert.equal(findPlannedPurchaseDesignation("計画を立てる", categoryConfig), false);
  assert.equal(findPlannedPurchaseDesignation("貯金が減った", categoryConfig), false);
  assert.equal(findPlannedPurchaseDesignation("", categoryConfig), false);

  assert.deepEqual(splitPlannedCorrection("計画購入", categoryConfig), { planned: true, rest: "" });
  const categoryCorrection = splitPlannedCorrection("雑費にして 計画購入", categoryConfig);
  assert.deepEqual(categoryCorrection, { planned: true, rest: "雑費にして" });
  assert.deepEqual(parseExpenseCorrection(categoryCorrection.rest, categoryConfig), { category: "雑費" });
  assert.deepEqual(splitPlannedCorrection("５００円だった", categoryConfig), { planned: false, rest: "500円だった" });
  assert.equal(isPlannedPayload(JSON.parse(JSON.stringify({ planned: 1 }))), true);
  assert.equal(isPlannedPayload({ planned: 0 }), false);
  assert.equal(isPlannedPayload({}), false);
  assert.equal(isPlannedPayload({ planned: "1" }), true);
  assert.equal(isPlannedPayload({ planned: "yes" }), false);
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

test("趣味の支出だけ金額で4段階の叱り尺度を決める", () => {
  assert.equal(SCOLD_LEVEL1_MIN_AMOUNT, 10_000);
  assert.equal(SCOLD_LEVEL2_MIN_AMOUNT, 20_000);
  assert.equal(SCOLD_LEVEL3_MIN_AMOUNT, 40_000);
  assert.equal(scoldLevel("食費", 50_000), 0);
  assert.equal(scoldLevel("サブスク", 50_000), 0);
  assert.equal(scoldLevel("交際費", 50_000), 0);
  assert.equal(scoldLevel("趣味", 9_999), 0);
  assert.equal(scoldLevel("趣味", SCOLD_LEVEL1_MIN_AMOUNT), 1);
  assert.equal(scoldLevel("趣味", 19_999), 1);
  assert.equal(scoldLevel("趣味", SCOLD_LEVEL2_MIN_AMOUNT), 2);
  assert.equal(scoldLevel("趣味", 39_999), 2);
  assert.equal(scoldLevel("趣味", SCOLD_LEVEL3_MIN_AMOUNT), 3);
  assert.equal(scoldLevel(normalizeExpenseCategory("ゲーム", categoryConfig), 15_000), 1);
});

test("支出コメント生成は尺度0でAIを呼ばず、尺度1〜3で1回だけ呼ぶ", async () => {
  let calls = 0;
  const loadPersona = async (): Promise<string> => "テスト用ユウカ";
  const generate = async (prompt: string, temperature: number): Promise<string> => {
    calls += 1;
    assert.ok(prompt.length > 0);
    assert.equal(temperature, 0.6);
    return "記録できる形に整えておきます。";
  };

  await expenseAiComment(0, 2_000, "食費", "昼食", null, loadPersona, generate);
  assert.equal(calls, 0);
  await expenseAiComment(1, 2_000, "趣味", "本", null, loadPersona, generate);
  assert.equal(calls, 1);
  await expenseAiComment(2, 20_000, "趣味", "ゲーム機", "店", loadPersona, generate);
  assert.equal(calls, 2);
  await expenseAiComment(3, 40_000, "趣味", "ゲーム機", "店", loadPersona, generate);
  assert.equal(calls, 3);
});

test("計画購入の支出コメントは金額に関係なく定型文だけで返す", async () => {
  let personaCalls = 0;
  let generateCalls = 0;
  const loadPersona = async (): Promise<string> => {
    personaCalls += 1;
    return "テスト用ユウカ";
  };
  const generate = async (): Promise<string> => {
    generateCalls += 1;
    return "AIの一言。";
  };
  const answer = await expenseAiComment(3, 40_000, "趣味", "本", null, loadPersona, generate, true);
  assert.ok(expenseAsidesPlanned.includes(answer));
  assert.equal(personaCalls, 0);
  assert.equal(generateCalls, 0);
});

test("支出コメント生成は空応答・例外時に各段階の定型へ戻る", async () => {
  const loadPersona = async (): Promise<string> => "テスト用ユウカ";
  const empty = async (): Promise<string> => "";
  assert.ok(expenseAsidesLevel1.includes(await expenseAiComment(1, 10_000, "趣味", "本", null, loadPersona, empty)));
  assert.ok(expenseAsidesLevel2.includes(await expenseAiComment(2, 20_000, "趣味", "本", null, loadPersona, empty)));
  assert.ok(expenseAsidesLevel3.includes(await expenseAiComment(3, 40_000, "趣味", "本", null, loadPersona, empty)));
  const throws = async (): Promise<string> => {
    throw new Error("test failure");
  };
  assert.ok(expenseAsidesLevel2.includes(await expenseAiComment(2, 20_000, "趣味", "本", null, loadPersona, throws)));
});

test("段階1・2の指示文は予備文を例として含み、段階3は含めない", async () => {
  const prompts: string[] = [];
  const loadPersona = async (): Promise<string> => "テスト用ユウカ";
  const generate = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return "生成した一言。";
  };

  await expenseAiComment(1, 10_000, "趣味", "本", null, loadPersona, generate);
  assert.match(prompts[0], new RegExp(expenseAsidesLevel1[0]));
  assert.match(prompts[0], new RegExp(expenseAsidesLevel1[1]));
  assert.match(prompts[0], /言い回しは例文と変え、自分の言葉で書く/);

  await expenseAiComment(2, 20_000, "趣味", "本", null, loadPersona, generate);
  assert.match(prompts[1], new RegExp(expenseAsidesLevel2[0]));
  assert.match(prompts[1], new RegExp(expenseAsidesLevel2[1]));
  assert.match(prompts[1], /言い回しは例文と変え、自分の言葉で書く/);

  await expenseAiComment(3, 40_000, "趣味", "本", null, loadPersona, generate);
  assert.doesNotMatch(prompts[2], new RegExp(expenseAsidesLevel3[0]));
  assert.doesNotMatch(prompts[2], /言い回しは例文と変え、自分の言葉で書く/);
});

test("月の入力は年月・日付・月名を正規化し、境界外を無効にする", () => {
  const today = { year: 2026, month: 10 };
  assert.deepEqual(parseExpenseMonth("2026-07", today), { kind: "month", year: 2026, month: 7 });
  assert.deepEqual(parseExpenseMonth("2026/7", today), { kind: "month", year: 2026, month: 7 });
  assert.deepEqual(parseExpenseMonth("２０２６年７月", today), { kind: "month", year: 2026, month: 7 });
  assert.deepEqual(parseExpenseMonth("2026-07-15", today), { kind: "month", year: 2026, month: 7 });
  assert.deepEqual(parseExpenseMonth("7月", today), { kind: "month", year: 2026, month: 7 });
  assert.deepEqual(parseExpenseMonth("12月", today), { kind: "month", year: 2025, month: 12 });
  assert.deepEqual(parseExpenseMonth("10月", today), { kind: "month", year: 2026, month: 10 });
  assert.deepEqual(parseExpenseMonth("7", today), { kind: "month", year: 2026, month: 7 });
  assert.deepEqual(parseExpenseMonth("2027-01", today), { kind: "month", year: 2027, month: 1 });
  for (const input of ["2026-00", "2026-13", "0000-01", "13月", "来月", "7.5", ""]) {
    assert.deepEqual(parseExpenseMonth(input, today), { kind: "invalid" }, input);
  }
});

test("期間指定は月入力を優先し、旧値と年跨ぎを解決する", () => {
  assert.deepEqual(resolveExpenseRange({}, { year: 2026, month: 10 }), { kind: "month", year: 2026, month: 10 });
  assert.deepEqual(resolveExpenseRange({ range: "month" }, { year: 2026, month: 10 }), { kind: "month", year: 2026, month: 10 });
  assert.deepEqual(resolveExpenseRange({ range: "last_month" }, { year: 2026, month: 10 }), { kind: "month", year: 2026, month: 9 });
  assert.deepEqual(resolveExpenseRange({ range: "two_months_ago" }, { year: 2026, month: 10 }), { kind: "month", year: 2026, month: 8 });
  assert.deepEqual(resolveExpenseRange({ range: "last_month" }, { year: 2026, month: 1 }), { kind: "month", year: 2025, month: 12 });
  assert.deepEqual(resolveExpenseRange({ range: "two_months_ago" }, { year: 2026, month: 2 }), { kind: "month", year: 2025, month: 12 });
  assert.deepEqual(resolveExpenseRange({ range: "all" }, { year: 2026, month: 10 }), { kind: "all" });
  assert.deepEqual(resolveExpenseRange({ range: "all", month: "7月" }, { year: 2026, month: 10 }), { kind: "month", year: 2026, month: 7 });
  assert.deepEqual(resolveExpenseRange({ range: "zzz" }, { year: 2026, month: 10 }), { kind: "invalid" });
});

test("期間の境界はうるう年と全期間を正しく表す", () => {
  assert.deepEqual(expenseRangeBounds({ kind: "month", year: 2028, month: 2 }), {
    start: "2028-02-01T00:00:00+09:00",
    end: "2028-02-29T23:59:59+09:00"
  });
  assert.equal(expenseRangeBounds({ kind: "month", year: 2026, month: 12 })?.end, "2026-12-31T23:59:59+09:00");
  assert.equal(expenseRangeBounds({ kind: "all" }), null);
});

test("支出候補の完全性をカード条件と共有する", () => {
  assert.equal(isExpenseCandidateComplete({ amount: 500, item: "電池" }), true);
  assert.equal(isExpenseCandidateComplete({ amount: null, item: "電池" }), false);
  assert.equal(isExpenseCandidateComplete({ amount: 500, content: "昼食代" }), true);
  assert.equal(isExpenseCandidateComplete({ amount: 500, item: "" }), false);
});

test("完全な支出候補がある時だけ通常の雑談返信を落とし、要望案内は残す", () => {
  const expense = { type: "expense_candidate" as const, amount: 500, item: "電池" };
  const chat = { type: "chat_reply" as const, reply: "通常返信" };
  const guidance = { type: "chat_reply" as const, request_guidance: true, reply: "要望案内" };
  const todo = { type: "todo_candidate" as const, content: "作業" };
  assert.deepEqual(dropChatReplyWhenExpenseCard([expense, chat, guidance, todo]), [expense, guidance, todo]);
  assert.deepEqual(
    dropChatReplyWhenExpenseCard([{ type: "expense_candidate" as const, amount: null, item: "電池" }, chat]),
    [{ type: "expense_candidate", amount: null, item: "電池" }, chat]
  );
  assert.deepEqual(dropChatReplyWhenExpenseCard([chat]), [chat]);
});

test("支出コメントの定型文は段階ごとの本数と禁止語を守る", () => {
  assert.equal(expenseAsides.length, 7);
  assert.equal(expenseAsidesPlanned.length, 5);
  assert.equal(expenseAsidesLevel1.length, 5);
  assert.equal(expenseAsidesLevel2.length, 5);
  assert.equal(expenseAsidesLevel3.length, 5);
  for (const phrase of expenseAsides) {
    assert.match(phrase, /。$/);
    assert.doesNotMatch(phrase, /小言|感謝|！|？/);
  }
  for (const phrase of expenseAsidesPlanned) {
    assert.match(phrase, /。$/);
    assert.doesNotMatch(phrase, /！|？|小言/);
  }
  for (const phrase of [...expenseAsidesLevel1, ...expenseAsidesLevel2]) {
    assert.match(phrase, /。$/);
    assert.doesNotMatch(phrase, /！|？/);
  }
  for (const phrase of expenseAsidesLevel3) {
    assert.match(phrase, /。$/);
  }
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
