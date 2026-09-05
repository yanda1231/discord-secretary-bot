import { YUUKA_PHRASES } from "./yuuka-phrases";
import { HIDDEN_ADULT_PRANK_HINTS, HIDDEN_ADULT_PRANK_KEYWORDS } from "./hidden-reaction-patterns";
import {
  buildExpenseHierarchyParts,
  findCategoryDesignation,
  fitDiscordContent,
  hasCorrectionCue,
  normalizeExpenseCategory,
  parseExpenseCorrection,
  resolveCorrectionTarget,
  type CorrectionTargetDecision,
  type ExpenseCorrection
} from "./expense-logic";
import { YUUKA_MANUAL } from "./yuuka-manual";
import expenseCategories from "./expense-categories.json";

const EXPENSE_CATEGORIES = expenseCategories as string[];

export interface Env {
  DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  REPORT_CHANNEL_ID: string;
  SETTING_CHANNEL_ID?: string;
  TODO_CHANNEL_ID?: string;
  REMINDER_CHANNEL_ID?: string;
  CHAT_CHANNEL_ID?: string;
  MUTTER_CHANNEL_ID?: string;
  TIMEZONE?: string;
  MORNING_REPORT_HOUR?: string;
  MORNING_REPORT_TIME?: string;
  EVENING_REPORT_TIME?: string;
  MONTHLY_EXPENSE_REPORT_TIME?: string;
  PRE_NOTIFY_MINUTES?: string;
  STALE_TODO_DAYS?: string;
}

type DiscordInteraction = {
  id: string;
  token: string;
  type: number;
  channel_id?: string;
  message?: {
    id: string;
    channel_id?: string;
    content?: string;
  };
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string;
    custom_id?: string;
    options?: DiscordOption[];
    components?: {
      components?: {
        custom_id?: string;
        value?: string;
      }[];
    }[];
    values?: string[];
  };
};

type DiscordUser = {
  id: string;
  username?: string;
  global_name?: string;
};

type DiscordOption = {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordOption[];
};

type ParsedItem = {
  content: string;
  datetime: string | null;
  confidence: "high" | "medium" | "low";
  note?: string;
  recurrence_rule?: RecurrenceRule | null;
  recurrence_label?: string | null;
};

type RecurrenceRule = {
  type: "daily" | "weekly" | "monthly";
  interval?: number;
  weekdays?: number[];
  month_days?: number[];
  time?: string;
  timezone?: string;
};

type TodoRow = {
  id: number;
  content: string;
  due_at: string | null;
  done: number;
  notified: number;
  pre_notify_minutes?: number | null;
  pre_notified?: number;
  due_notified?: number;
  snoozed_until?: string | null;
  created_at: string;
};

type ReminderRow = {
  id: number;
  content: string;
  remind_at: string;
  notified: number;
  pre_notify_minutes?: number | null;
  pre_notified?: number;
  due_notified?: number;
  recurrence_rule?: string | null;
  recurrence_label?: string | null;
  recurrence_timezone?: string | null;
  last_fired_at?: string | null;
  recurrence_active?: number;
  created_at: string;
};

type ExpenseRow = {
  id: number;
  amount: number;
  category: string | null;
  memo: string;
  store: string | null;
  spent_at: string;
  created_at: string;
};

type DiscordMessage = {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: { id: string; username?: string; bot?: boolean };
  message_reference?: {
    channel_id?: string;
    message_id?: string;
  };
  referenced_message?: {
    id: string;
    channel_id?: string;
    content: string;
    author?: { id: string; username?: string; bot?: boolean };
    message_reference?: {
      channel_id?: string;
      message_id?: string;
    };
  } | null;
  attachments?: { id: string; filename: string; url: string; content_type?: string; size?: number }[];
};

type BotChannels = {
  setting?: string;
  todo?: string;
  reminder?: string;
  chat?: string;
  mutter?: string;
  report: string;
};

type ChatEvent = {
  type: "chat_reply" | "todo_candidate" | "reminder_candidate" | "reminder_delete_candidate" | "done_candidate" | "expense_candidate" | "none";
  content?: string;
  datetime?: string | null;
  recurrence_rule?: RecurrenceRule | null;
  recurrence_label?: string | null;
  todo_id?: number | null;
  reminder_id?: number | null;
  amount?: number | null;
  category?: string | null;
  item?: string | null;
  store?: string | null;
  confidence?: "high" | "medium" | "low";
  reply?: string;
};

type MessageProcessResult = "processed" | "retry" | "ignored";

type PreNotifyMode = "ask" | "fixed" | "off";

type PendingActionRow = {
  id: string;
  kind: string;
  payload: string;
  requested_by: string;
  channel_id?: string;
  expires_at: string;
  message_id?: string | null;
};

const INTERACTION = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5
} as const;

const RESPONSE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9
} as const;

const EPHEMERAL = 1 << 6;
const GEMINI_MESSAGE_RETRY_LIMIT = 5;
const GEMINI_OUTAGE_MINUTES = 30;

class GeminiUnavailableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GeminiUnavailableError";
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "GET") {
      return new Response("Discord Secretary Bot is running.");
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.text();
    const verified = await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY);
    if (!verified) {
      return new Response("Invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(body) as DiscordInteraction;
    if (interaction.type === INTERACTION.PING) {
      return json({ type: RESPONSE.PONG });
    }

    try {
      if (interaction.type === INTERACTION.MESSAGE_COMPONENT) {
        return handleComponent(interaction, env);
      }

      if (interaction.type === INTERACTION.MODAL_SUBMIT) {
        return handleModalSubmit(interaction, env, ctx);
      }

      if (interaction.type === INTERACTION.APPLICATION_COMMAND) {
        return handleCommand(interaction, env, ctx);
      }

      return reply("未対応のInteractionです。", true);
    } catch (error) {
      console.error(error);
      return reply("処理中にエラーが起きました。ログを確認してください。", true);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env));
  }
};

async function verifyDiscordRequest(request: Request, body: string, publicKeyHex: string): Promise<boolean> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKeyHex) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToArrayBuffer(publicKeyHex),
      { name: "Ed25519" } as AlgorithmIdentifier,
      false,
      ["verify"]
    );
    return crypto.subtle.verify(
      { name: "Ed25519" } as AlgorithmIdentifier,
      key,
      hexToArrayBuffer(signature),
      new TextEncoder().encode(timestamp + body)
    );
  } catch (error) {
    console.error("Discord signature verification failed:", error);
    return false;
  }
}

async function handleCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const name = interaction.data?.name;
  if (name === "todo") return handleTodoCommand(interaction, env, ctx);
  if (name === "reminder") return handleReminderCommand(interaction, env, ctx);
  if (name === "expense") return handleExpenseCommand(interaction, env);
  if (name === "guide") return reply(YUUKA_PHRASES.commandGuide(EXPENSE_CATEGORIES), true);
  if (name === "backup") {
    ctx.waitUntil(processBackupCommand(interaction, env));
    return deferReply(true);
  }
  return reply(YUUKA_PHRASES.unknownCommand, true);
}

async function handleTodoCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const sub = firstOption(interaction);
  if (!sub) return reply("todoサブコマンドを指定してください。", true);

  if (sub.name === "add") {
    const text = getString(sub, "text");
    if (!text) return reply("登録したい内容を書いてください。", true);
    if (isHiddenAdultPrankTrigger(text)) return reply(randomItem(YUUKA_PHRASES.hiddenAdultPranks), true);
    ctx.waitUntil(processTodoAdd(interaction, env, text));
    return deferReply(false);
  }

  if (sub.name === "list") {
    const range = getString(sub, "range") ?? "all";
    const rows = await listTodos(env, range);
    return todoListWithDoneButtons(rows, range);
  }

  if (sub.name === "done") {
    const id = getNumber(sub, "id");
    if (!id) return todoDonePicker(env);
    const result = await env.DB.prepare(
      "UPDATE todos SET done = 1, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND done = 0"
    ).bind(id).run();
    return reply(result.meta.changes ? `todo #${id} を完了として記録しました。` : `todo #${id} が見つからないか、すでに完了済みです。`, true);
  }

  return reply("未対応のtodoサブコマンドです。", true);
}

async function handleReminderCommand(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const sub = firstOption(interaction);
  if (!sub) return reply("reminderサブコマンドを指定してください。", true);

  if (sub.name === "add") {
    const text = getString(sub, "text");
    if (!text) return reply("リマインドしたい内容を書いてください。", true);
    if (isHiddenAdultPrankTrigger(text)) return reply(randomItem(YUUKA_PHRASES.hiddenAdultPranks), true);
    ctx.waitUntil(processReminderAdd(interaction, env, text));
    return deferReply(false);
  }

  if (sub.name === "list") {
    const rows = await listReminders(env);
    return reminderListWithDeleteButtons(rows);
  }

  return reply("未対応のreminderサブコマンドです。", true);
}

async function handleExpenseCommand(interaction: DiscordInteraction, env: Env): Promise<Response> {
  const sub = firstOption(interaction);
  if (!sub) return reply("expenseサブコマンドを指定してください。", true);

  if (sub.name === "list") {
    const range = getString(sub, "range") ?? "all";
    const rows = await listExpenses(env, range);
    return expenseListWithDeleteButtons(rows, range, env);
  }

  return reply("未対応のexpenseサブコマンドです。", true);
}

async function processBackupCommand(interaction: DiscordInteraction, env: Env): Promise<void> {
  try {
    await editOriginalInteractionResponse(interaction, env, { content: YUUKA_PHRASES.backupStarted });
    const channels = await loadChannels(env);
    await postBackupToReport(env, channels.report, "manual");
    await editOriginalInteractionResponse(interaction, env, { content: YUUKA_PHRASES.backupCompleted });
  } catch (error) {
    console.error("manual backup failed", error);
    await editOriginalInteractionResponse(interaction, env, { content: YUUKA_PHRASES.backupFailed });
  }
}

async function handleComponent(interaction: DiscordInteraction, env: Env): Promise<Response> {
  const customId = interaction.data?.custom_id ?? "";
  const [prefix, id, action] = customId.split(":");
  if (prefix === "due" && id) {
    return json({
      type: RESPONSE.MODAL,
      data: {
        custom_id: `due_modal:${id}`,
        title: "todoの期限を設定",
        components: [{
          type: 1,
          components: [{
            type: 4,
            custom_id: "due_text",
            label: "期限",
            style: 1,
            placeholder: "例: 今日22時 / 明日朝 / 7月3日18時",
            required: true,
            max_length: 100
          }]
        }]
      }
    });
  }

  if (prefix === "remind" && id) {
    return json({
      type: RESPONSE.MODAL,
      data: {
        custom_id: `remind_modal:${id}`,
        title: "リマインダーの日時を設定",
        components: [{
          type: 1,
          components: [{
            type: 4,
            custom_id: "remind_text",
            label: "日時",
            style: 1,
            placeholder: "例: 10分後 / 今日22時 / 明日朝",
            required: true,
            max_length: 100
          }]
        }]
      }
    });
  }

  if (prefix === "pretime" && id) {
    return json({
      type: RESPONSE.MODAL,
      data: {
        custom_id: `pre_modal:${id}`,
        title: "事前通知を設定",
        components: [{
          type: 1,
          components: [{
            type: 4,
            custom_id: "pre_text",
            label: "事前通知（数字だけなら分）",
            style: 1,
            placeholder: "例: 15分前 / 1時間前 / 120（120分=2時間前） / なし",
            required: true,
            max_length: 50
          }]
        }]
      }
    });
  }

  if (prefix === "done" && id) {
    const result = await env.DB.prepare(
      "UPDATE todos SET done = 1, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND done = 0"
    ).bind(Number(id)).run();
    return updateMessage(result.meta.changes
      ? appendInteractionMessage(interaction, `todo #${id} を完了として記録しました。\n計算通り、完璧です。`)
      : `todo #${id} は見つからないか、すでに完了済みです。`);
  }

  if (prefix === "todo_wait" && id) {
    return json({
      type: RESPONSE.UPDATE_MESSAGE,
      data: {
        content: appendInteractionMessage(interaction, `todo #${id} はまだ終わっていないんですね。\n先生、再通知の時間を選んでください。期限そのものは変更しません。`),
        components: todoSnoozeComponents(Number(id))
      }
    });
  }

  if (prefix === "todo_snooze" && id && action) {
    const nextAt = snoozeDate(action, env);
    if (!nextAt) return reply("未対応の再通知です。", true);
    const result = await env.DB.prepare(
      "UPDATE todos SET snoozed_until = ?, due_notified = 0, notified = 0 WHERE id = ? AND done = 0"
    ).bind(nextAt, Number(id)).run();
    return updateMessage(result.meta.changes
      ? appendInteractionMessage(interaction, `todo #${id} を再通知します。\n再通知: ${formatDate(nextAt, env)}\n期限は変えていません。そこ、重要な変数ですからね。`)
      : `todo #${id} は見つからないか、すでに完了済みです。`);
  }

  if (prefix === "expense_cat" && id) {
    return processExpenseCategorySelect(interaction, env, id);
  }

  if (prefix === "expense" && id && action) {
    const pending = await env.DB.prepare(
      "SELECT id, kind, payload, requested_by, expires_at FROM pending_actions WHERE id = ?"
    ).bind(id).first<PendingActionRow>();
    return processExpensePendingAction(interaction, env, pending, action);
  }

  if (prefix === "expense_delete" && id) {
    const result = await env.DB.prepare("DELETE FROM expenses WHERE id = ?")
      .bind(Number(id))
      .run();
    return updateMessage(result.meta.changes
      ? `支出メモ #${id} を削除しました。`
      : `支出メモ #${id} が見つかりませんでした。`);
  }

  if (prefix === "reminder_done" && id) {
    const result = await env.DB.prepare(
      "UPDATE reminders SET notified = 1, due_notified = 1 WHERE id = ?"
    ).bind(Number(id)).run();
    return updateMessage(result.meta.changes
      ? appendInteractionMessage(interaction, `リマインダー #${id} を対応済みにしました。`)
      : `リマインダー #${id} が見つかりませんでした。`);
  }

  if (prefix === "recurring_done" && id) {
    return updateMessage(appendInteractionMessage(interaction, `リマインダー #${id} を対応済みにしました。`));
  }

  if (prefix === "recurring_snooze" && id && action) {
    const nextAt = snoozeDate(action, env);
    if (!nextAt) return reply("未対応のスヌーズです。", true);
    const reminder = await getReminderById(env, Number(id));
    if (!reminder) return updateMessage(`リマインダー #${id} が見つかりませんでした。`);
    const inserted = await env.DB.prepare(
      "INSERT INTO reminders (content, remind_at, pre_notify_minutes) VALUES (?, ?, NULL) RETURNING id"
    ).bind(reminder.content, nextAt).first<{ id: number }>();
    return updateMessage(appendInteractionMessage(
      interaction,
      `リマインダー #${id} の今回分をスヌーズしました。\n再通知: ${formatDate(nextAt, env)}\n単発の再通知 #${inserted?.id ?? "?"} として管理します。`
    ));
  }

  if (prefix === "reminder_delete" && id) {
    const result = await env.DB.prepare("DELETE FROM reminders WHERE id = ?")
      .bind(Number(id))
      .run();
    return updateMessage(result.meta.changes
      ? appendInteractionMessage(interaction, `リマインダー #${id} を削除しました。`)
      : `リマインダー #${id} が見つかりませんでした。`);
  }

  if (prefix === "snooze" && id && action) {
    const nextAt = snoozeDate(action, env);
    if (!nextAt) return reply("未対応のスヌーズです。", true);
    const result = await env.DB.prepare(
      `UPDATE reminders
       SET remind_at = ?, notified = 0, pre_notified = 0, due_notified = 0, pre_notify_minutes = NULL
       WHERE id = ?`
    ).bind(nextAt, Number(id)).run();
    return updateMessage(result.meta.changes
      ? appendInteractionMessage(interaction, `リマインダー #${id} をスヌーズしました。\n次回: ${formatDate(nextAt, env)}\n……まったく、今度は忘れないでくださいね。`)
      : `リマインダー #${id} が見つかりませんでした。`);
  }

  if (prefix === "pre" && id && action !== undefined) {
    const pending = await env.DB.prepare(
      "SELECT id, kind, payload, requested_by, expires_at FROM pending_actions WHERE id = ?"
    ).bind(id).first<{ id: string; kind: string; payload: string; requested_by: string; expires_at: string }>();
    if (!pending) return updateMessage("この確認は見つからないか、処理済みです。");
    if (new Date(pending.expires_at).getTime() < Date.now()) {
      const payload = JSON.parse(pending.payload) as Record<string, string | number | null>;
      await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
      return updateMessage(expiredPendingContent(pending.kind, payload));
    }
    if (pending.kind !== "todo" && pending.kind !== "reminder") {
      return reply("この確認では事前通知を変更できません。", true);
    }

    const minutes = Math.max(0, Math.min(180, Number(action)));
    const payload = JSON.parse(pending.payload) as Record<string, string | number | null>;
    if (isHiddenAdultPrankTrigger(pendingPayloadText(payload))) {
      await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
      return updateMessage(randomItem(YUUKA_PHRASES.hiddenAdultPranks));
    }
    payload.pre_notify_minutes = minutes > 0 ? minutes : null;
    payload.pre_notify_pending = null;
    await env.DB.prepare("UPDATE pending_actions SET payload = ? WHERE id = ?")
      .bind(JSON.stringify(payload), id)
      .run();
    return json({
      type: RESPONSE.UPDATE_MESSAGE,
      data: {
        content: pendingContent(pending.kind, payload),
        components: pendingComponents(id, pendingComponentOptions(pending.kind, payload))
      }
    });
  }

  if (prefix !== "confirm" || !id || !action) {
    return reply("未対応のボタンです。", true);
  }

  const pending = await env.DB.prepare(
    "SELECT id, kind, payload, requested_by, expires_at FROM pending_actions WHERE id = ?"
  ).bind(id).first<{ id: string; kind: string; payload: string; requested_by: string; expires_at: string }>();

  if (!pending) return updateMessage("この確認は見つからないか、処理済みです。");
  if (pending.kind === "expense") {
    return processExpensePendingAction(interaction, env, pending, action);
  }
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    const payload = JSON.parse(pending.payload) as Record<string, string | number | null>;
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
    return updateMessage(expiredPendingContent(pending.kind, payload));
  }

  const payload = JSON.parse(pending.payload) as Record<string, string | number | null>;
  if (action === "cancel") {
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
    return updateMessage([
      pendingContent(pending.kind, payload),
      "",
      "取り消しました。"
    ].join("\n"));
  }

  if (isHiddenAdultPrankTrigger(pendingPayloadText(payload))) {
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
    return updateMessage(randomItem(YUUKA_PHRASES.hiddenAdultPranks));
  }
  if ((pending.kind === "todo" || pending.kind === "reminder") && payload.pre_notify_pending) {
    return json({
      type: RESPONSE.UPDATE_MESSAGE,
      data: {
        content: [
          pendingContent(pending.kind, payload),
          "",
          YUUKA_PHRASES.preNotifyRequired,
          "`事前通知を設定` から何分前に通知するか入力するか、`事前通知を設定しない` を押してください。"
        ].join("\n"),
        components: pendingComponents(id, pendingComponentOptions(pending.kind, payload))
      }
    });
  }

  if (pending.kind === "todo") {
    const inserted = await env.DB.prepare("INSERT INTO todos (content, due_at, pre_notify_minutes) VALUES (?, ?, ?) RETURNING id")
      .bind(String(payload.content ?? ""), stringOrNull(payload.due_at), numberOrNull(payload.pre_notify_minutes))
      .first<{ id: number }>();
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
    return updateMessage([
      pendingContent(pending.kind, payload),
      "",
      registeredContent("todo", inserted?.id, payload)
    ].join("\n"));
  }

  if (pending.kind === "reminder") {
    if (!payload.remind_at) {
      return json({
        type: RESPONSE.UPDATE_MESSAGE,
        data: {
          content: [
            pendingContent(pending.kind, payload),
            "",
            "先生、日時の変数が未定です。このままではリマインダーとして成立しません。",
            "`日時を設定` から、いつ通知するか入力してください。"
          ].join("\n"),
          components: pendingComponents(id, pendingComponentOptions(pending.kind, payload))
        }
      });
    }
    const inserted = await env.DB.prepare(
      `INSERT INTO reminders (content, remind_at, pre_notify_minutes, recurrence_rule, recurrence_label, recurrence_timezone)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
    )
      .bind(
        String(payload.content ?? ""),
        String(payload.remind_at ?? ""),
        numberOrNull(payload.pre_notify_minutes),
        stringOrNull(payload.recurrence_rule),
        stringOrNull(payload.recurrence_label),
        stringOrNull(payload.recurrence_rule) ? env.TIMEZONE ?? "Asia/Tokyo" : null
      )
      .first<{ id: number }>();
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
    return updateMessage([
      pendingContent(pending.kind, payload),
      "",
      registeredContent("reminder", inserted?.id, payload),
      reminderRegisteredComment(String(payload.content ?? ""))
    ].filter(Boolean).join("\n"));
  }

  if (pending.kind === "done") {
    const todoId = Number(payload.todo_id);
    const result = await env.DB.prepare(
      "UPDATE todos SET done = 1, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND done = 0"
    ).bind(todoId).run();
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
    return updateMessage(result.meta.changes
      ? [
        pendingContent(pending.kind, payload),
        "",
        `todo #${todoId} を完了として記録しました。\n計算通り、完璧です。`
      ].join("\n")
      : `todo #${todoId} は見つからないか、すでに完了済みです。`);
  }

  if (pending.kind === "reminder_delete") {
    const reminderId = Number(payload.reminder_id);
    const result = await env.DB.prepare("DELETE FROM reminders WHERE id = ?")
      .bind(reminderId)
      .run();
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
    return updateMessage(result.meta.changes
      ? [
        pendingContent(pending.kind, payload),
        "",
        `リマインダー #${reminderId} を削除しました。`
      ].join("\n")
      : `リマインダー #${reminderId} は見つからないか、すでに削除済みです。`);
  }

  return updateMessage("未対応の確認種別です。");
}

const EXPENSE_PENDING_UNAVAILABLE = "その候補は期限切れか処理済みです。";

function ignorePendingInteraction(): Response {
  return json({
    type: RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "", flags: EPHEMERAL }
  });
}

function expensePendingPayload(pending: PendingActionRow): Record<string, string | number | null> {
  try {
    return JSON.parse(pending.payload) as Record<string, string | number | null>;
  } catch {
    return {};
  }
}

function isPendingOwner(interaction: DiscordInteraction, pending: PendingActionRow): boolean {
  return interactionUser(interaction).id === pending.requested_by;
}

async function processExpensePendingAction(
  interaction: DiscordInteraction,
  env: Env,
  pending: PendingActionRow | null,
  action: string
): Promise<Response> {
  if (!pending || pending.kind !== "expense") return updateMessage(EXPENSE_PENDING_UNAVAILABLE);
  if (!isPendingOwner(interaction, pending)) return ignorePendingInteraction();

  const payload = expensePendingPayload(pending);
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ? AND kind = 'expense' AND requested_by = ?")
      .bind(pending.id, pending.requested_by)
      .run();
    return updateMessage(EXPENSE_PENDING_UNAVAILABLE);
  }

  if (action === "cancel") {
    const deleted = await env.DB.prepare(
      "DELETE FROM pending_actions WHERE id = ? AND kind = 'expense' AND requested_by = ?"
    ).bind(pending.id, pending.requested_by).run();
    return updateMessage(deleted.meta.changes
      ? expenseCancelledContent(payload)
      : EXPENSE_PENDING_UNAVAILABLE);
  }
  if (action !== "ok") return reply("未対応の支出ボタンです。", true);

  const latest = await env.DB.prepare(
    "SELECT id, kind, payload, requested_by, channel_id, expires_at, message_id FROM pending_actions WHERE id = ? AND kind = 'expense' AND requested_by = ?"
  ).bind(pending.id, pending.requested_by).first<PendingActionRow>();
  if (!latest) return updateMessage(EXPENSE_PENDING_UNAVAILABLE);
  return recordExpensePendingAction(env, latest, expensePendingPayload(latest));
}

async function recordExpensePendingAction(
  env: Env,
  pending: PendingActionRow,
  payload: Record<string, string | number | null>
): Promise<Response> {
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ? AND kind = 'expense' AND requested_by = ?")
      .bind(pending.id, pending.requested_by)
      .run();
    return updateMessage(EXPENSE_PENDING_UNAVAILABLE);
  }
  if (isHiddenAdultPrankTrigger(pendingPayloadText(payload))) {
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ? AND kind = 'expense' AND requested_by = ?")
      .bind(pending.id, pending.requested_by)
      .run();
    return updateMessage(randomItem(YUUKA_PHRASES.hiddenAdultPranks));
  }

  const amount = Math.max(0, Math.round(Number(payload.amount ?? 0)));
  if (!amount) return updateMessage("金額が読み取れませんでした。もう一度書き直してください。");
  const category = normalizeExpenseCategory(payload.category, EXPENSE_CATEGORIES);
  const memo = String(payload.memo ?? payload.item ?? payload.content ?? "");
  const store = stringOrNull(payload.store);
  const spentAt = String(payload.spent_at ?? new Date().toISOString());
  const deleted = await env.DB.prepare(
    "DELETE FROM pending_actions WHERE id = ? AND kind = 'expense' AND requested_by = ?"
  ).bind(pending.id, pending.requested_by).run();
  if (!deleted.meta.changes) return updateMessage(EXPENSE_PENDING_UNAVAILABLE);

  await env.DB.prepare(
    "INSERT INTO expenses (amount, category, memo, store, spent_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(amount, category, memo, store, spentAt).run();
  return updateMessage(expenseRecordedContent({
    ...payload,
    amount,
    category,
    memo,
    store,
    spent_at: spentAt
  }));
}

async function processExpenseCategorySelect(interaction: DiscordInteraction, env: Env, id: string): Promise<Response> {
  const pending = await env.DB.prepare(
    "SELECT id, kind, payload, requested_by, channel_id, expires_at, message_id FROM pending_actions WHERE id = ? AND kind = 'expense'"
  ).bind(id).first<PendingActionRow>();
  if (!pending) return updateMessage(EXPENSE_PENDING_UNAVAILABLE);
  if (!isPendingOwner(interaction, pending)) return ignorePendingInteraction();
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ? AND kind = 'expense' AND requested_by = ?")
      .bind(id, pending.requested_by)
      .run();
    return updateMessage(EXPENSE_PENDING_UNAVAILABLE);
  }

  const selected = interaction.data?.values?.[0]?.normalize("NFKC").trim();
  const category = selected
    ? EXPENSE_CATEGORIES.find((candidate) => candidate.normalize("NFKC") === selected)
    : undefined;
  if (!category) return reply("その大分類は一覧にありません。プルダウンから選んでください。", true);

  const updated = await env.DB.prepare(
    "UPDATE pending_actions SET payload = json_set(payload, '$.category', ?) WHERE id = ? AND kind = 'expense' AND requested_by = ?"
  ).bind(category, id, pending.requested_by).run();
  if (!updated.meta.changes) return updateMessage(EXPENSE_PENDING_UNAVAILABLE);

  const latest = await env.DB.prepare(
    "SELECT id, kind, payload, requested_by, channel_id, expires_at, message_id FROM pending_actions WHERE id = ? AND kind = 'expense'"
  ).bind(id).first<PendingActionRow>();
  if (!latest) return updateMessage(EXPENSE_PENDING_UNAVAILABLE);
  const payload = expensePendingPayload(latest);
  return updateMessageWithComponents(
    pendingContent("expense", payload),
    pendingExpenseComponents(id, payload)
  );
}

async function handleModalSubmit(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const customId = interaction.data?.custom_id ?? "";
  const [prefix, id] = customId.split(":");
  if ((prefix !== "due_modal" && prefix !== "remind_modal" && prefix !== "pre_modal") || !id) {
    return reply("未対応の入力フォームです。", true);
  }

  ctx.waitUntil(processPendingModalSubmit(interaction, env, prefix, id));
  return json({ type: RESPONSE.DEFERRED_UPDATE_MESSAGE });
}

async function processPendingModalSubmit(interaction: DiscordInteraction, env: Env, prefix: string, id: string): Promise<void> {
  const pending = await env.DB.prepare(
    "SELECT id, kind, payload, requested_by, expires_at FROM pending_actions WHERE id = ?"
  ).bind(id).first<{ id: string; kind: string; payload: string; requested_by: string; expires_at: string }>();

  if (!pending) {
    await editInteractionMessage(interaction, env, { content: "この確認は見つからないか、処理済みです。", components: [] });
    return;
  }
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    const payload = JSON.parse(pending.payload) as Record<string, string | number | null>;
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
    await editInteractionMessage(interaction, env, { content: expiredPendingContent(pending.kind, payload), components: [] });
    return;
  }
  if (prefix === "due_modal" && pending.kind !== "todo") {
    await editInteractionMessage(interaction, env, { content: "この入力フォームではtodoの期限だけ変更できます。", components: [] });
    return;
  }
  if (prefix === "remind_modal" && pending.kind !== "reminder") {
    await editInteractionMessage(interaction, env, { content: "この入力フォームではリマインダーの日時だけ変更できます。", components: [] });
    return;
  }
  if (prefix === "pre_modal" && pending.kind !== "todo" && pending.kind !== "reminder") {
    await editInteractionMessage(interaction, env, { content: "この入力フォームではtodoまたはリマインダーの事前通知だけ変更できます。", components: [] });
    return;
  }
  const payload = JSON.parse(pending.payload) as Record<string, string | number | null>;

  if (prefix === "pre_modal") {
    const preText = modalValue(interaction, "pre_text").trim();
    const minutes = parsePreNotifyText(preText);
    if (isHiddenAdultPrankTrigger(pendingPayloadText(payload, preText))) {
      await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
      await editInteractionMessage(interaction, env, { content: randomItem(YUUKA_PHRASES.hiddenAdultPranks), components: [] });
      return;
    }
    if (minutes === undefined) {
      await editInteractionMessage(interaction, env, {
        content: [
          pendingContent(pending.kind, payload),
          "",
          YUUKA_PHRASES.preNotifyParseError,
          "例: `15分前`、`15ふんまえ`、`1時間前`、`120`、`なし` のように入力してください。数字だけなら分として扱います。"
        ].join("\n"),
        components: pendingComponents(id, pendingComponentOptions(pending.kind, payload))
      });
      return;
    }
    payload.pre_notify_minutes = minutes > 0 ? minutes : null;
    payload.pre_notify_pending = null;
    await env.DB.prepare("UPDATE pending_actions SET payload = ? WHERE id = ?")
      .bind(JSON.stringify(payload), id)
      .run();
    await editInteractionMessage(interaction, env, {
      content: pendingContent(pending.kind, payload),
      components: pendingComponents(id, pendingComponentOptions(pending.kind, payload))
    });
    return;
  }

  const inputText = modalValue(interaction, prefix === "due_modal" ? "due_text" : "remind_text").trim();
  if (isHiddenAdultPrankTrigger(pendingPayloadText(payload, inputText))) {
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ?").bind(id).run();
    await editInteractionMessage(interaction, env, { content: randomItem(YUUKA_PHRASES.hiddenAdultPranks), components: [] });
    return;
  }
  if (!inputText) {
    await editInteractionMessage(interaction, env, { content: "日時が空です。例: 明日18時、今日22時、10分後、のように入力してください。" });
    return;
  }

  const parsedAt = await parseDueText(env, inputText, String(payload.content ?? ""));
  if (!parsedAt) {
    await editInteractionMessage(interaction, env, {
      content: [
        pendingContent(pending.kind, payload),
        "",
        "先生、日時の変数がまだ解けませんでした。",
        "例: `10分後`、`明日18時`、`今日22時`、`7月3日18時` のように入力してください。"
      ].join("\n"),
      components: pendingComponents(id, pendingComponentOptions(pending.kind, payload))
    });
    return;
  }

  const payloadWithTime: Record<string, string | number | null> = pending.kind === "todo"
    ? { ...payload, due_at: parsedAt }
    : { ...payload, remind_at: parsedAt };
  if (pending.kind === "reminder" && payloadWithTime.recurrence_rule) {
    const recurrence = normalizeRecurrenceRule(payloadWithTime.recurrence_rule, parsedAt, env.TIMEZONE ?? "Asia/Tokyo");
    payloadWithTime.recurrence_rule = serializeRecurrenceRule(recurrence);
    payloadWithTime.recurrence_label = payloadWithTime.recurrence_label ?? recurrenceLabel(recurrence);
  }
  delete payloadWithTime.pre_notify_minutes;
  const preparedPayload = await preparePreNotifyPayload(env, pending.kind as "todo" | "reminder", payloadWithTime);
  preparedPayload.confirmation_base_content = pending.kind === "todo"
    ? rebuildTodoConfirmationBase(payload, parsedAt)
    : rebuildReminderConfirmationBase(payload, parsedAt);

  await env.DB.prepare("UPDATE pending_actions SET payload = ? WHERE id = ?")
    .bind(JSON.stringify(preparedPayload), id)
    .run();

  await editInteractionMessage(interaction, env, {
    content: pendingContent(pending.kind, preparedPayload),
    components: pendingComponents(id, pendingComponentOptions(pending.kind, preparedPayload))
  });
}

async function processTodoAdd(interaction: DiscordInteraction, env: Env, text: string): Promise<void> {
  try {
    if (isHiddenAdultPrankTrigger(text)) {
      await editOriginalInteractionResponse(interaction, env, { content: randomItem(YUUKA_PHRASES.hiddenAdultPranks) });
      return;
    }
    const parsed = await parseNaturalText(env, "todo", text);
    if (!parsed.content) {
      await editOriginalInteractionResponse(interaction, env, { content: "todoとして読み取れませんでした。少し具体的に書いてください。" });
      return;
    }
    const message = await createPendingMessage(interaction, env, "todo", {
      content: parsed.content,
      due_at: parsed.datetime
    });
    await editOriginalInteractionResponse(interaction, env, message);
  } catch (error) {
    console.error(error);
    await editOriginalInteractionResponse(interaction, env, { content: isGeminiUnavailableError(error) ? YUUKA_PHRASES.geminiUnavailable : "todo候補の作成中にエラーが起きました。少し時間をおいてもう一度試してください。" });
  }
}

async function todoDonePicker(env: Env): Promise<Response> {
  const todos = await listTodos(env, "all");
  if (!todos.length) return reply("未完了todoはありません。計算通り、きれいな状態です。", true);
  const targets = todos.slice(0, 10);
  const rows = [];
  for (let i = 0; i < targets.length; i += 5) {
    rows.push({
      type: 1,
      components: targets.slice(i, i + 5).map((todo) => ({
        type: 2,
        style: 3,
        label: `#${todo.id} 完了`,
        custom_id: `done:${todo.id}`
      }))
    });
  }
  return json({
    type: RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: [
        "先生、完了にするtodoを選んでください。",
        "変数を間違えないよう、こちらで候補を並べておきました。",
        "",
        formatTodos(targets, "all")
      ].join("\n"),
      flags: EPHEMERAL,
      components: rows
    }
  });
}

function todoListWithDoneButtons(todos: TodoRow[], range: string): Response {
  if (!todos.length) return reply(`todo (${range}): なし`, true);
  const targets = todos.slice(0, 10);
  const rows = [];
  for (let i = 0; i < targets.length; i += 5) {
    rows.push({
      type: 1,
      components: targets.slice(i, i + 5).map((todo) => ({
        type: 2,
        style: 3,
        label: `#${todo.id} 完了`,
        custom_id: `done:${todo.id}`
      }))
    });
  }
  return json({
    type: RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: [
        formatTodos(todos, range),
        "",
        "完了したtodoは下のボタンで記録できます。"
      ].join("\n"),
      flags: EPHEMERAL,
      components: rows
    }
  });
}

function reminderListWithDeleteButtons(reminders: ReminderRow[]): Response {
  if (!reminders.length) return reply("リマインダー: なし", true);
  const targets = reminders.slice(0, 10);
  const rows = [];
  for (let i = 0; i < targets.length; i += 5) {
    rows.push({
      type: 1,
      components: targets.slice(i, i + 5).map((reminder) => ({
        type: 2,
        style: 4,
        label: `#${reminder.id} 削除`,
        custom_id: `reminder_delete:${reminder.id}`
      }))
    });
  }
  return json({
    type: RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: [
        formatReminders(reminders),
        "",
        "不要になったリマインダーは下のボタンで削除できます。"
      ].join("\n"),
      flags: EPHEMERAL,
      components: rows
    }
  });
}

function expenseListWithDeleteButtons(expenses: ExpenseRow[], range: string, env: Env): Response {
  if (!expenses.length) return reply(formatExpenses(expenses, range, env), true);
  const targets = expenses.slice(0, 10);
  const rows = [];
  for (let i = 0; i < targets.length; i += 5) {
    rows.push({
      type: 1,
      components: targets.slice(i, i + 5).map((expense) => ({
        type: 2,
        style: 4,
        label: `#${expense.id} 削除`,
        custom_id: `expense_delete:${expense.id}`
      }))
    });
  }
  return json({
    type: RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: fitDiscordContent([
        formatExpenses(expenses, range, env),
        "",
        "間違って登録した支出メモは下のボタンで削除できます。"
      ], 1900),
      flags: EPHEMERAL,
      components: rows
    }
  });
}

async function processReminderAdd(interaction: DiscordInteraction, env: Env, text: string): Promise<void> {
  try {
    if (isHiddenAdultPrankTrigger(text)) {
      await editOriginalInteractionResponse(interaction, env, { content: randomItem(YUUKA_PHRASES.hiddenAdultPranks) });
      return;
    }
    const parsed = await parseNaturalText(env, "reminder", text);
    if (!parsed.content) {
      await editOriginalInteractionResponse(interaction, env, { content: "リマインダーとして読み取れませんでした。少し具体的に書いてください。" });
      return;
    }
    const message = await createPendingMessage(interaction, env, "reminder", {
      content: parsed.content,
      remind_at: parsed.datetime,
      recurrence_rule: serializeRecurrenceRule(parsed.recurrence_rule ?? null),
      recurrence_label: parsed.recurrence_label ?? recurrenceLabel(parsed.recurrence_rule ?? null)
    });
    await editOriginalInteractionResponse(interaction, env, message);
  } catch (error) {
    console.error(error);
    await editOriginalInteractionResponse(interaction, env, { content: isGeminiUnavailableError(error) ? YUUKA_PHRASES.geminiUnavailable : "リマインダー候補の作成中にエラーが起きました。少し時間をおいてもう一度試してください。" });
  }
}

async function createPendingMessage(interaction: DiscordInteraction, env: Env, kind: "todo" | "reminder", payload: Record<string, string | number | null>): Promise<Record<string, unknown>> {
  if (isHiddenAdultPrankTrigger(pendingPayloadText(payload))) {
    return { content: randomItem(YUUKA_PHRASES.hiddenAdultPranks), components: [] };
  }
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const user = interactionUser(interaction);
  const preparedPayload = await preparePreNotifyPayload(env, kind, payload);

  const baseContent = kind === "todo"
    ? `この内容でtodoに登録しますか？\n${formatTodoCandidate(String(preparedPayload.content ?? ""), stringOrNull(preparedPayload.due_at))}`
    : [
      `この内容でリマインダーに登録しますか？`,
      formatReminderCandidate(String(preparedPayload.content ?? ""), stringOrNull(preparedPayload.remind_at), stringOrNull(preparedPayload.recurrence_label)),
      preparedPayload.remind_at ? "" : "先生、日時の変数が未定です。いつ通知するか設定してください。"
    ].filter(Boolean).join("\n");
  const payloadWithContent = { ...preparedPayload, confirmation_base_content: baseContent };
  await env.DB.prepare(
    "INSERT INTO pending_actions (id, kind, payload, requested_by, channel_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, kind, JSON.stringify(payloadWithContent), user.id, interaction.channel_id ?? "", expires).run();

  return {
    content: pendingContent(kind, payloadWithContent),
    components: pendingComponents(id, pendingComponentOptions(kind, payloadWithContent))
  };
}

async function createPendingPost(env: Env, channelId: string, userId: string, kind: "todo" | "reminder" | "done" | "reminder_delete" | "expense", payload: Record<string, string | number | null>, content: string, replyToMessageId?: string): Promise<void> {
  if (isHiddenAdultPrankTrigger(pendingPayloadText(payload, content))) {
    await postDiscordSafeReply(env, channelId, replyToMessageId, randomItem(YUUKA_PHRASES.hiddenAdultPranks));
    return;
  }
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const preparedPayload = kind === "todo" || kind === "reminder" ? await preparePreNotifyPayload(env, kind, payload) : payload;
  const payloadWithContent = { ...preparedPayload, confirmation_base_content: content };
  await env.DB.prepare(
    "INSERT INTO pending_actions (id, kind, payload, requested_by, channel_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, kind, JSON.stringify(payloadWithContent), userId, channelId, expires).run();

  const okLabel = kind === "done" ? "完了にする" : kind === "reminder_delete" ? "削除する" : "確定";
  const cancelLabel = kind === "done" ? "違う" : kind === "reminder_delete" ? "残す" : "取り消し";
  const components = kind === "done" || kind === "reminder_delete" ? [{
    type: 1,
    components: [
      { type: 2, style: 3, label: okLabel, custom_id: `confirm:${id}:ok` },
      { type: 2, style: 4, label: cancelLabel, custom_id: `confirm:${id}:cancel` }
    ]
  }] : kind === "expense"
    ? pendingExpenseComponents(id, payloadWithContent)
    : pendingComponents(id, pendingComponentOptions(kind, preparedPayload));
  const posted = await postDiscordPayload(env, channelId, {
    content: kind === "todo" || kind === "reminder" || kind === "expense" ? pendingContent(kind, payloadWithContent) : content,
    components,
    ...(replyToMessageId ? { message_reference: { message_id: replyToMessageId, channel_id: channelId } } : {})
  });
  if (posted?.id) {
    await env.DB.prepare("UPDATE pending_actions SET message_id = ? WHERE id = ? AND kind = ?")
      .bind(posted.id, id, kind)
      .run();
  }
}

async function pollNaturalLanguageChannels(env: Env): Promise<void> {
  const channels = await loadChannels(env);
  const targets = [
    { kind: "setting", id: channels.setting },
    { kind: "todo", id: channels.todo },
    { kind: "reminder", id: channels.reminder },
    { kind: "chat", id: channels.chat }
  ].filter((item): item is { kind: string; id: string } => Boolean(item.id));

  for (const target of targets) {
    try {
      await pollChannel(env, target.kind, target.id);
    } catch (error) {
      console.error(`Polling failed for ${target.kind}:${target.id}`, error);
    }
  }
}

async function pollChannel(env: Env, kind: string, channelId: string): Promise<void> {
  const state = await env.DB.prepare("SELECT last_message_id FROM channel_states WHERE channel_id = ?")
    .bind(channelId)
    .first<{ last_message_id: string | null }>();
  const messages = await fetchDiscordMessages(env, channelId, state?.last_message_id ?? undefined);
  if (!messages.length) return;

  const sorted = messages.sort((a, b) => compareSnowflakes(a.id, b.id));
  const newest = sorted[sorted.length - 1]?.id;
  if (!state?.last_message_id && kind !== "setting") {
    const recent = sorted.filter((message) => Date.now() - new Date(message.timestamp).getTime() <= 5 * 60 * 1000);
    if (!recent.length) {
      await saveChannelState(env, channelId, newest);
      return;
    }
    sorted.splice(0, sorted.length, ...recent);
  }

  let hasRetry = false;
  for (const message of sorted) {
    if (message.author.bot) continue;
    const already = await env.DB.prepare("SELECT message_id FROM processed_messages WHERE message_id = ?")
      .bind(message.id)
      .first<{ message_id: string }>();
    if (already) continue;

    let shouldRetry = false;
    try {
      if (kind === "setting") await handleSettingMessage(env, message);
      if (kind === "todo") await handleTodoMessage(env, message);
      if (kind === "reminder") await handleReminderMessage(env, message);
      if (kind === "chat") await handleChatMessage(env, message);
      await clearGeminiMessageFailure(env, message.id);
    } catch (error) {
      console.error(`Message processing failed for ${kind}:${channelId}:${message.id}`, error);
      if (isGeminiUnavailableError(error)) {
        const attempts = await recordGeminiMessageFailure(env, kind, message);
        if (attempts < GEMINI_MESSAGE_RETRY_LIMIT) {
          shouldRetry = true;
          hasRetry = true;
        } else {
          await postDiscordReply(env, channelId, message.id, YUUKA_PHRASES.geminiUnavailable);
          await clearGeminiMessageFailure(env, message.id);
        }
      } else {
        await notifyFailureOncePerDay(env, "message_error", String(error));
      }
    }

    if (shouldRetry) continue;
    await env.DB.prepare("INSERT OR IGNORE INTO processed_messages (message_id, channel_id, kind) VALUES (?, ?, ?)")
      .bind(message.id, channelId, kind)
      .run();
  }

  if (!hasRetry) await saveChannelState(env, channelId, newest);
}

async function handleSettingMessage(env: Env, message: DiscordMessage): Promise<void> {
  for (const attachment of message.attachments ?? []) {
    if (!attachment.filename.toLowerCase().endsWith(".md")) continue;
    const response = await fetch(attachment.url);
    if (!response.ok) {
      await postDiscordMessage(env, message.channel_id, "先生、設定ファイルを取得できませんでした。添付し直してください。");
      continue;
    }
    const text = (await response.text()).trim();
    if (!text) {
      await postDiscordMessage(env, message.channel_id, "先生、添付されたMDが空です。人格設定の変数がありません。");
      continue;
    }
    await savePersona(env, text, `attachment:${attachment.filename}`);
    await postDiscordMessage(env, message.channel_id, `先生、人格設定を更新しました。\nファイル: ${attachment.filename}\nこれで私の応答方針は再計算済みです。`);
    return;
  }

  const configured = await applySettingsText(env, message.content);
  if (configured.length) {
    await postDiscordMessage(env, message.channel_id, [
      "先生、設定変数を更新しました。計算通りです。",
      ...configured.map((item) => `- ${item}`)
    ].join("\n"));
    return;
  }

  if (!message.content.trim() && !(message.attachments?.length ?? 0)) {
    await postDiscordMessage(env, message.channel_id, [
      "先生、投稿は確認できましたが、本文の変数が空として届いています。",
      "Discord Developer Portalの `MESSAGE CONTENT INTENT` がONか、botがこのチャンネルのメッセージ本文を読める権限を持っているか確認してください。"
    ].join("\n"));
    return;
  }

  if (message.content.includes("npm run register") || message.content.includes("DISCORD_BOT_TOKEN")) {
    await postDiscordMessage(env, message.channel_id, [
      "先生、そのコマンドはDiscordではなくMacのターミナルで実行するものです。",
      "ここでは実行できません。もし本物のBot Tokenを貼ってしまった場合は、Discord Developer PortalでTokenをリセットしてください。",
      "設定チャンネルでは、MDファイル添付、または `朝: 07:30` `夜: 22:45` `事前通知: 10` のような設定文を受け付けます。"
    ].join("\n"));
    return;
  }

  if (message.content.trim() || (message.attachments?.length ?? 0) > 0) {
    await postDiscordMessage(env, message.channel_id, [
      "先生、この設定は読み取れませんでした。",
      "SOUL.mdを反映する場合は、このチャンネルに `.md` ファイルを添付してください。",
      "時刻設定なら `朝: 07:30`、`夜: 22:45`、通知設定なら `事前通知: 10` のように書けます。"
    ].join("\n"));
  }
}

async function handleTodoMessage(env: Env, message: DiscordMessage): Promise<void> {
  if (!message.content.trim()) return;
  if (isHiddenAdultPrankTrigger(message.content)) {
    await postDiscordReply(env, message.channel_id, message.id, randomItem(YUUKA_PHRASES.hiddenAdultPranks));
    return;
  }
  const parsed = await parseNaturalText(env, "todo", message.content);
  if (!parsed.content) return;
  const aside = await aiAside(env, "todo候補を確認する短い一言。期限が未設定でも責めず、ユウカらしく。", { content: parsed.content, due_at: parsed.datetime });
  const content = [
    aside,
    "todo候補を検出しました。",
    formatTodoCandidate(parsed.content, parsed.datetime),
    parsed.datetime ? "" : "先生、期限の変数が未定です。期限なしでtodoにしますか？"
  ].filter(Boolean).join("\n");
  await createPendingPost(env, message.channel_id, message.author.id, "todo", { content: parsed.content, due_at: parsed.datetime }, content);
}

async function handleReminderMessage(env: Env, message: DiscordMessage): Promise<void> {
  if (!message.content.trim()) return;
  if (isHiddenAdultPrankTrigger(message.content)) {
    await postDiscordReply(env, message.channel_id, message.id, randomItem(YUUKA_PHRASES.hiddenAdultPranks));
    return;
  }
  const parsed = await parseNaturalText(env, "reminder", message.content);
  if (!parsed.content) return;
  const aside = await aiAside(env, "リマインダー候補を確認する短い一言。ユウカらしく、簡潔に。", { content: parsed.content, remind_at: parsed.datetime });
  const content = [
    aside,
    "リマインダー候補を検出しました。",
    formatReminderCandidate(parsed.content, parsed.datetime, parsed.recurrence_label ?? recurrenceLabel(parsed.recurrence_rule ?? null)),
    parsed.datetime ? "" : "先生、日時の変数が未定です。いつ通知するか設定してください。"
  ].filter(Boolean).join("\n");
  await createPendingPost(env, message.channel_id, message.author.id, "reminder", {
    content: parsed.content,
    remind_at: parsed.datetime,
    recurrence_rule: serializeRecurrenceRule(parsed.recurrence_rule ?? null),
    recurrence_label: parsed.recurrence_label ?? recurrenceLabel(parsed.recurrence_rule ?? null)
  }, content);
}

function messageReferenceId(message: DiscordMessage): string | undefined {
  return message.message_reference?.message_id ?? message.referenced_message?.id;
}

async function referencedMessageForCorrection(env: Env, message: DiscordMessage): Promise<DiscordMessage | null> {
  if (message.referenced_message?.author) {
    return {
      id: message.referenced_message.id,
      channel_id: message.referenced_message.channel_id ?? message.channel_id,
      content: message.referenced_message.content,
      timestamp: "",
      author: message.referenced_message.author ?? { id: "unknown" },
      message_reference: message.referenced_message.message_reference
    };
  }
  const referenceId = messageReferenceId(message);
  if (referenceId) {
    const fetched = await fetchDiscordMessage(env, message.channel_id, referenceId);
    if (fetched) return fetched;
  }
  if (!message.referenced_message) return null;
  return {
    id: message.referenced_message.id,
    channel_id: message.referenced_message.channel_id ?? message.channel_id,
    content: message.referenced_message.content,
    timestamp: "",
    author: message.referenced_message.author ?? { id: "unknown" },
    message_reference: message.referenced_message.message_reference
  };
}

async function handleExpenseCorrectionEntry(env: Env, message: DiscordMessage, text: string): Promise<boolean> {
  const referenceId = messageReferenceId(message);
  const isReply = Boolean(referenceId);
  const referencedMessage = isReply ? await referencedMessageForCorrection(env, message) : null;
  const referencedPending = referenceId
    ? await env.DB.prepare(
      "SELECT id, kind, payload, requested_by, channel_id, expires_at, message_id FROM pending_actions WHERE message_id = ? AND channel_id = ? AND kind = 'expense'"
    ).bind(referenceId, message.channel_id).first<PendingActionRow>()
    : null;
  const activeCandidates = !isReply && hasCorrectionCue(text)
    ? (await env.DB.prepare(
      "SELECT id, kind, payload, requested_by, channel_id, expires_at, message_id FROM pending_actions WHERE kind = 'expense' AND requested_by = ? AND channel_id = ? ORDER BY created_at ASC"
    ).bind(message.author.id, message.channel_id).all<PendingActionRow>()).results?.filter((candidate) => new Date(candidate.expires_at).getTime() >= Date.now()) ?? []
    : [];
  const referencedBotExpenseCard = Boolean(
    referencedMessage?.author.bot && referencedMessage.content.includes("支出候補を検出しました。")
  );
  const decision: CorrectionTargetDecision = resolveCorrectionTarget({
    isReply,
    referencedPending: Boolean(referencedPending),
    referencedBotExpenseCard,
    pendingCount: activeCandidates.length
  });

  if (decision === "reply_match") {
    if (!referencedPending) return true;
    if (referencedPending.requested_by !== message.author.id) return true;
    await handleExpenseCorrection(env, message, referencedPending);
    return true;
  }
  if (decision === "reply_expired_or_processed") {
    await postDiscordReply(env, message.channel_id, message.id, "その候補は期限切れか処理済みです。もう一度教えてください。");
    return true;
  }
  if (decision === "ambiguous") {
    await postDiscordReply(env, message.channel_id, message.id, "どのカードか、そのカードにリプライで教えてください。");
    return true;
  }
  if (decision === "single_pending") {
    const candidate = activeCandidates[0];
    if (candidate) await handleExpenseCorrection(env, message, candidate);
    return true;
  }
  return false;
}

async function parseExpenseCorrectionWithAi(env: Env, text: string, payload: Record<string, string | number | null>): Promise<ExpenseCorrection> {
  const prompt = [
    "支出候補の訂正文を読み、変わる項目だけJSONで返してください。変えない項目は省略してください。",
    "使用できるキー: category, memo, store, amount, spent_at",
    `大分類一覧: ${EXPENSE_CATEGORIES.join("、")}`,
    "categoryは大分類一覧から選び、一覧外ならその他にしてください。amountは整数の円。",
    "出力形式: {\"category\":\"雑費\",\"memo\":\"電池\",\"store\":\"まいばすけっと\",\"amount\":500,\"spent_at\":\"2026-09-05T00:00:00+09:00\"}",
    `現在の候補: ${JSON.stringify(payload)}`,
    `訂正文: ${text}`
  ].join("\n\n");
  const raw = await geminiText(env, prompt);
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const correction: ExpenseCorrection = {};
    if (Object.prototype.hasOwnProperty.call(parsed, "category")) {
      correction.category = normalizeExpenseCategory(parsed.category, EXPENSE_CATEGORIES);
    }
    for (const key of ["memo", "store", "spent_at"] as const) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
      const value = parsed[key];
      if (value === null) {
        correction[key] = null;
      } else if (typeof value === "string" && value.trim()) {
        correction[key] = value.trim();
      }
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "amount")) {
      const amount = Number(parsed.amount);
      if (Number.isSafeInteger(amount) && amount > 0) correction.amount = amount;
    }
    return correction;
  } catch {
    return {};
  }
}

function correctionFieldEntries(correction: ExpenseCorrection): [string, string | number | null][] {
  return (Object.entries(correction) as [string, string | number | null][])
    .filter(([key, value]) => ["category", "memo", "store", "amount", "spent_at"].includes(key) && value !== undefined);
}

function expenseCorrectionReply(correction: ExpenseCorrection): string {
  const changed = correctionFieldEntries(correction).map(([key, value]) => {
    if (value === null) return key === "store" ? "店を未設定" : "内容を未設定";
    if (key === "amount") return `${Number(value).toLocaleString("ja-JP")}円`;
    if (key === "spent_at") return `日付は${String(value)}`;
    return String(value);
  });
  return `${changed.join("、") || "内容"}ですね。直しました。`;
}

async function patchDiscordMessage(env: Env, channelId: string, messageId: string, data: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    });
    if (response.ok) return true;
    console.error(`Discord expense card patch error: ${response.status} ${await response.text()}`);
  } catch (error) {
    console.error("Discord expense card patch failed", error);
  }
  return false;
}

async function handleExpenseCorrection(env: Env, message: DiscordMessage, pending: PendingActionRow): Promise<void> {
  if (pending.requested_by !== message.author.id) return;
  const payload = expensePendingPayload(pending);
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await env.DB.prepare("DELETE FROM pending_actions WHERE id = ? AND kind = 'expense' AND requested_by = ?")
      .bind(pending.id, pending.requested_by)
      .run();
    await postDiscordReply(env, message.channel_id, message.id, "その候補は期限切れか処理済みです。もう一度教えてください。");
    return;
  }

  let correction = parseExpenseCorrection(message.content, EXPENSE_CATEGORIES);
  if (!correctionFieldEntries(correction).length) {
    correction = await parseExpenseCorrectionWithAi(env, message.content, payload);
  }
  const entries = correctionFieldEntries(correction);
  if (!entries.length) {
    await postDiscordReply(env, message.channel_id, message.id, "どこを直すか読み取れませんでした。大分類・品物・店・金額のどれかを教えてください。");
    return;
  }

  let expression = "payload";
  const bindings: (string | number | null)[] = [];
  for (const [key, value] of entries) {
    expression = `json_set(${expression}, '$.${key}', ?)`;
    bindings.push(value);
  }
  const updated = await env.DB.prepare(
    `UPDATE pending_actions SET payload = ${expression}
     WHERE id = ? AND kind = 'expense' AND requested_by = ?`
  ).bind(...bindings, pending.id, pending.requested_by).run();
  if (!updated.meta.changes) {
    await postDiscordReply(env, message.channel_id, message.id, "その候補は期限切れか処理済みです。もう一度教えてください。");
    return;
  }

  const latest = await env.DB.prepare(
    "SELECT id, kind, payload, requested_by, channel_id, expires_at, message_id FROM pending_actions WHERE id = ? AND kind = 'expense'"
  ).bind(pending.id).first<PendingActionRow>();
  if (!latest) {
    await postDiscordReply(env, message.channel_id, message.id, "その候補は期限切れか処理済みです。もう一度教えてください。");
    return;
  }
  const latestPayload = expensePendingPayload(latest);
  const cardMessageId = latest.message_id ?? messageReferenceId(message);
  const cardUpdated = cardMessageId
    ? await patchDiscordMessage(env, message.channel_id, cardMessageId, {
      content: fitDiscordContent([pendingContent("expense", latestPayload)], 1900),
      components: pendingExpenseComponents(latest.id, latestPayload)
    })
    : false;
  const response = cardUpdated
    ? expenseCorrectionReply(correction)
    : `${expenseCorrectionReply(correction)} 保存はしましたがカードの表示更新に失敗しました。記録するを押すと保存内容で記録されます。`;
  await postDiscordReply(env, message.channel_id, message.id, response);
}

async function handleChatMessage(env: Env, message: DiscordMessage): Promise<void> {
  const text = message.content.trim();
  if (!text) return;

  const replyChain = await buildReplyChain(env, message);
  const correctionHandled = await handleExpenseCorrectionEntry(env, message, text);
  if (correctionHandled) return;
  if (isHiddenAdultPrankTrigger(chatGuardText(text, replyChain))) {
    await postDiscordReply(env, message.channel_id, message.id, randomItem(YUUKA_PHRASES.hiddenAdultPranks));
    return;
  }

  const events = await classifyChatEvents(env, text, replyChain);
  const actionable = events.filter((event) => event.type !== "none").slice(0, 4);
  if (!actionable.length && shouldChatReply(text)) {
    actionable.push({ type: "chat_reply", content: text });
  }

  for (const event of actionable) {
    if (event.type === "todo_candidate" && event.content) {
      const aside = await aiAside(env, "雑談からtodo候補を見つけた時の短い一言。ユウカらしく。", event);
      await createPendingPost(env, message.channel_id, message.author.id, "todo", { content: event.content, due_at: event.datetime ?? null }, [
        aside,
        "todo候補を検出しました。",
        formatTodoCandidate(event.content, event.datetime ?? null)
      ].filter(Boolean).join("\n"), message.id);
      continue;
    }

    if (event.type === "reminder_candidate" && event.content) {
      if (!event.datetime) {
        const aside = await aiAside(env, "雑談から日時未定のリマインダー候補を見つけた時の短い一言。ユウカらしく。", event);
        await createPendingPost(env, message.channel_id, message.author.id, "reminder", {
          content: event.content,
          remind_at: null,
          recurrence_rule: serializeRecurrenceRule(event.recurrence_rule ?? null),
          recurrence_label: event.recurrence_label ?? recurrenceLabel(event.recurrence_rule ?? null)
        }, [
          aside,
          "リマインダー候補を検出しました。",
          formatReminderCandidate(event.content, null, event.recurrence_label ?? recurrenceLabel(event.recurrence_rule ?? null)),
          "先生、日時の変数が未定です。いつ通知するか設定してください。"
        ].filter(Boolean).join("\n"), message.id);
        continue;
      }
      const aside = await aiAside(env, "雑談から予定やリマインダー候補を見つけた時の短い一言。ユウカらしく。", event);
      await createPendingPost(env, message.channel_id, message.author.id, "reminder", {
        content: event.content,
        remind_at: event.datetime,
        recurrence_rule: serializeRecurrenceRule(event.recurrence_rule ?? null),
        recurrence_label: event.recurrence_label ?? recurrenceLabel(event.recurrence_rule ?? null)
      }, [
        aside,
        "リマインダー候補を検出しました。",
        formatReminderCandidate(event.content, event.datetime, event.recurrence_label ?? recurrenceLabel(event.recurrence_rule ?? null))
      ].filter(Boolean).join("\n"), message.id);
      continue;
    }

    if (event.type === "reminder_delete_candidate") {
      const candidate = event.reminder_id ? await getReminderById(env, event.reminder_id) : await findReminderCandidate(env, event.content ?? text);
      if (!candidate) {
        await postDiscordReply(env, message.channel_id, message.id, "先生、削除対象のリマインダーを特定できませんでした。\n`/reminder list` から削除するか、もう少し具体的に書いてください。");
        continue;
      }
      const aside = await aiAside(env, "リマインダー削除確認の短い一言。ユウカらしく、確認を促す。", { reminder: candidate.content, remind_at: candidate.remind_at });
      await createPendingPost(
        env,
        message.channel_id,
        message.author.id,
        "reminder_delete",
        { reminder_id: candidate.id },
        [aside, `先生、リマインダー #${candidate.id}「${candidate.content}」を削除しますか？`, `日時: ${candidate.remind_at}`].filter(Boolean).join("\n"),
        message.id
      );
      continue;
    }

    if (event.type === "done_candidate") {
      const candidate = event.todo_id ? await getTodoById(env, event.todo_id) : await findCompletionCandidate(env, event.content ?? text);
      if (!candidate) continue;
      const aside = await aiAside(env, "todo完了確認の短い一言。ユウカらしく、少し嬉しそうに。", { todo: candidate.content });
      await createPendingPost(
        env,
        message.channel_id,
        message.author.id,
        "done",
        { todo_id: candidate.id },
        [aside, `先生、「${candidate.content}」は完了でよろしいですか？`, "問題なければ、完了として記録しておきます。"].filter(Boolean).join("\n"),
        message.id
      );
      continue;
    }

    if (event.type === "expense_candidate" && event.amount && (event.item ?? event.content)) {
      const amount = Math.round(Number(event.amount));
      const category = normalizeExpenseCategory(event.category, EXPENSE_CATEGORIES);
      const item = String(event.item ?? event.content).trim();
      const memo = normalizeExpenseMemo(item, category);
      const store = stringOrNull(event.store);
      const aside = await expenseAiComment(env, amount, category, memo, store);
      await createPendingPost(
        env,
        message.channel_id,
        message.author.id,
        "expense",
        {
          amount,
          category,
          item,
          memo,
          store,
          ai_comment: aside,
          spent_at: event.datetime ?? new Date().toISOString()
        },
        [
          aside,
          "支出候補を検出しました。",
          formatExpenseCandidate(amount, category, memo, store, event.datetime ?? new Date().toISOString())
        ].filter(Boolean).join("\n"),
        message.id
      );
      continue;
    }

    if (event.type === "chat_reply") {
      const persona = await loadPersona(env);
      const expenseContext = shouldIncludeExpenseContext(text) ? await buildExpenseContext(env) : "";
      const answer = replyChain.length ? await chatReplyWithContext(env, text, replyChain, expenseContext) : event.reply && !expenseContext ? event.reply : await geminiText(env, [
        personaPrompt(persona),
        manualPrompt(),
        "Discordの雑談ルームで、先生に短く自然に返答してください。タスク登録は自動で確定しない。1〜3文。",
        "ユーザーが求めていない限り、雑談を打ち切ったり、別行動へ誘導したりしないでください。",
        expenseContext ? "先生は支出・浪費・予算について話しています。支出状況を踏まえて、会計担当として自然に返してください。数字は支出状況にあるものだけ使い、捏造しないでください。" : "",
        expenseContext,
        `先生の発言: ${text}`
      ].filter(Boolean).join("\n\n"), 0.75);
      if (answer) await postDiscordReply(env, message.channel_id, message.id, answer);
      else await notifyFailureOncePerDay(env, "empty_reply", "msg:" + message.id);
    }
  }
}

async function parseNaturalText(env: Env, kind: "todo" | "reminder", text: string): Promise<ParsedItem> {
  const timezone = env.TIMEZONE ?? "Asia/Tokyo";
  const now = new Date().toISOString();
  const prompt = [
    "自然文をJSONだけで構造化してください。",
    `現在時刻: ${now}`,
    `タイムゾーン: ${timezone}`,
    `種別: ${kind}`,
    "出力形式: {\"content\":\"...\",\"datetime\":\"YYYY-MM-DDTHH:mm:ss+09:00 または null\",\"confidence\":\"high|medium|low\",\"note\":\"...\",\"recurrence_rule\":null または {\"type\":\"daily|weekly|monthly\",\"interval\":1,\"weekdays\":[1],\"month_days\":[1],\"time\":\"09:00\",\"timezone\":\"Asia/Tokyo\"},\"recurrence_label\":\"毎週月曜\" または null}",
    "todoは期限が不明ならdatetimeをnullにしてよい。reminderは日時が不明ならdatetimeをnullにする。",
    "reminderで「毎日」「毎週月曜」「毎月1日」など繰り返しが明確ならrecurrence_ruleを入れる。曜日は月曜=1、火曜=2、水曜=3、木曜=4、金曜=5、土曜=6、日曜=7。",
    "recurrence_rule.timeは時刻が分かる場合だけHH:mmで入れる。datetimeは最初に通知する次回日時。",
    "本文にない情報を勝手に足しすぎない。日付だけの場合は09:00にする。",
    `入力: ${text}`
  ].join("\n");
  const raw = await geminiText(env, prompt);
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  const parsed = JSON.parse(jsonText) as Partial<ParsedItem>;
  const recurrence = kind === "reminder" ? normalizeRecurrenceRule(parsed.recurrence_rule ?? null, parsed.datetime ? String(parsed.datetime) : null, timezone) : null;
  return {
    content: String(parsed.content ?? text).trim(),
    datetime: parsed.datetime ? String(parsed.datetime) : null,
    confidence: parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low" ? parsed.confidence : "medium",
    note: parsed.note,
    recurrence_rule: recurrence,
    recurrence_label: kind === "reminder" ? String(parsed.recurrence_label ?? recurrenceLabel(recurrence) ?? "").trim() || null : null
  };
}

async function parseDueText(env: Env, dueText: string, todoContent: string): Promise<string | null> {
  const timezone = env.TIMEZONE ?? "Asia/Tokyo";
  const prompt = [
    "todoの期限表現をJSONだけで構造化してください。",
    `現在時刻: ${new Date().toISOString()}`,
    `タイムゾーン: ${timezone}`,
    `todo内容: ${todoContent}`,
    "出力形式: {\"datetime\":\"YYYY-MM-DDTHH:mm:ss+09:00 または null\"}",
    "日付だけの場合は09:00。本文にない情報を勝手に足しすぎない。",
    "期限として不明確すぎる場合はdatetimeをnullにしてください。",
    `期限表現: ${dueText}`
  ].join("\n");
  const raw = await geminiText(env, prompt);
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  const parsed = JSON.parse(jsonText) as { datetime?: string | null };
  return parsed.datetime ? String(parsed.datetime) : null;
}

async function geminiText(env: Env, prompt: string, temperature = 0.2): Promise<string> {
  const model = env.GEMINI_MODEL ?? "gemini-3.5-flash";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature }
      })
    });
  } catch (error) {
    throw new GeminiUnavailableError(`Gemini API fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new GeminiUnavailableError(`Gemini API error: ${response.status} ${body}`, response.status);
  }
  const data = await response.json<{ candidates?: { content?: { parts?: { text?: string }[] } }[] }>();
  await markGeminiHealthy(env);
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";
}

function isGeminiUnavailableError(error: unknown): boolean {
  return error instanceof GeminiUnavailableError;
}

type ReplyContext = {
  author: "bot" | "user";
  content: string;
};

async function buildReplyChain(env: Env, message: DiscordMessage, limit = 16): Promise<ReplyContext[]> {
  const chain: ReplyContext[] = [];
  const seen = new Set<string>([message.id]);
  let current: DiscordMessage | null = message.referenced_message
    ? {
      id: message.referenced_message.id,
      channel_id: message.referenced_message.channel_id ?? message.message_reference?.channel_id ?? message.channel_id,
      content: message.referenced_message.content,
      timestamp: "",
      author: message.referenced_message.author ?? { id: "unknown" },
      message_reference: message.referenced_message.message_reference
    }
    : null;
  let nextId = message.message_reference?.message_id ?? current?.id;
  let nextChannelId = message.message_reference?.channel_id ?? message.channel_id;

  while (chain.length < limit && nextId && nextChannelId && !seen.has(nextId)) {
    seen.add(nextId);
    if (!current || current.id !== nextId) {
      current = await fetchDiscordMessage(env, nextChannelId, nextId);
    }
    if (!current) break;
    const content = current.content.trim();
    if (content) {
      chain.push({
        author: current.author.bot ? "bot" : "user",
        content
      });
    }
    nextId = current.message_reference?.message_id;
    nextChannelId = current.message_reference?.channel_id ?? current.channel_id;
    current = null;
  }

  return chain.reverse();
}

function formatReplyChain(replyChain: ReplyContext[]): string {
  if (!replyChain.length) return "なし";
  return replyChain
    .map((item, index) => `${index + 1}. ${item.author === "bot" ? "ユウカ" : "先生"}: ${item.content}`)
    .join("\n");
}

async function classifyChatEvents(env: Env, text: string, replyChain: ReplyContext[] = []): Promise<ChatEvent[]> {
  const openTodos = await listTodos(env, "all");
  const openReminders = await listReminders(env);
  const expenseHistory = await buildExpenseCategoryHistory(env);
  const prompt = [
    manualPrompt(),
    "大分類一覧: " + EXPENSE_CATEGORIES.join("|"),
    "直近の支出から作った分類履歴（JSON 1行・最大15組）:\n" + expenseHistory,
    "Discordの雑談発言から、複数のイベントを抽出し、JSONだけで返してください。",
    "1つの発言に雑談、todo、リマインダー、完了報告が混ざる場合は、それぞれ別イベントにしてください。",
    "typeは chat_reply/todo_candidate/reminder_candidate/reminder_delete_candidate/done_candidate/expense_candidate/none のどれか。",
    "明確に予定・時刻・リマインド依頼ならreminder_candidate。リマインダーを消す/削除する/いらないという依頼ならreminder_delete_candidate。やること・締切・todo依頼ならtodo_candidate。完了報告ならdone_candidate。支払い・購入・課金・浪費・金額の記録ならexpense_candidate。感情ケアや普通の会話で返答した方がよければchat_reply。",
    "介入不要なら [{\"type\":\"none\"}]。",
    "expense_candidateではitemに品物、storeに店を入れ、categoryは大分類一覧から1つだけ選んでください。contentは従来形式のフォールバックとして残しても構いません。",
    "出力形式: {\"events\":[{\"type\":\"chat_reply|todo_candidate|reminder_candidate|reminder_delete_candidate|done_candidate|expense_candidate|none\",\"content\":\"...\",\"item\":\"品物\",\"store\":\"店\",\"datetime\":\"YYYY-MM-DDTHH:mm:ss+09:00 または null\",\"recurrence_rule\":null または {\"type\":\"daily|weekly|monthly\",\"interval\":1,\"weekdays\":[1],\"month_days\":[1],\"time\":\"09:00\",\"timezone\":\"Asia/Tokyo\"},\"recurrence_label\":\"毎週月曜\" または null,\"todo_id\":数値またはnull,\"reminder_id\":数値またはnull,\"amount\":金額数値またはnull,\"category\":\"大分類一覧のいずれか\",\"confidence\":\"high|medium|low\",\"reply\":\"...\"}]}",
    "chat_replyのreplyはユウカとして1〜3文。todo/reminder/doneの事実は変えない。",
    "雑談では、ユーザーが求めていない限り会話を打ち切ったり、別行動へ誘導したりしない。照れ隠しは会話の返答として自然な範囲に留める。",
    "reminder_delete_candidateは未通知リマインダー一覧から最も近いものを選び、確信できる場合はreminder_idを入れてください。曖昧ならcontentだけ入れてreminder_idはnull。",
    "reminder_candidateで「毎日」「毎週月曜」「毎月1日」など繰り返しが明確ならrecurrence_ruleを入れる。曜日は月曜=1、火曜=2、水曜=3、木曜=4、金曜=5、土曜=6、日曜=7。datetimeは最初に通知する次回日時。",
    "expense_candidateは金額が明確に読み取れる場合だけ。金額がない購入話はchat_replyかnone。",
    "expense_candidateのcontentは月末レポート用のメモです。カテゴリ名だけにせず、「本を購入」「フィギュアを購入」「昼食代」のように何に使ったか分かる短い表現にしてください。",
    `現在時刻: ${new Date().toISOString()}`,
    `タイムゾーン: ${env.TIMEZONE ?? "Asia/Tokyo"}`,
    `未完了todo:\n${openTodos.map((todo) => `#${todo.id} ${todo.content}`).join("\n") || "なし"}`,
    `未通知リマインダー:\n${openReminders.map((reminder) => `#${reminder.id} ${reminder.content} / ${reminder.remind_at}`).join("\n") || "なし"}`,
    `リプライ会話の文脈:\n${formatReplyChain(replyChain)}`,
    `リプライ文脈の発言数: ${replyChain.length}/16（最大8ラリー相当）`,
    "リプライ会話の文脈がある場合、先生の発言がその続きなら文脈を踏まえてchat_replyにしてください。ただし明確なtodo/reminder/expense/doneは別イベントとして抽出してください。",
    `発言: ${text}`
  ].join("\n\n");
  try {
    const raw = await geminiText(env, prompt);
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    const parsed = JSON.parse(jsonText) as { events?: ChatEvent[] };
    let events = Array.isArray(parsed.events) && parsed.events.length ? parsed.events : [{ type: "none" } as ChatEvent];
    events = events.map((event) => {
      const recurrence = event.type === "reminder_candidate"
        ? normalizeRecurrenceRule(event.recurrence_rule ?? null, event.datetime ?? null, env.TIMEZONE ?? "Asia/Tokyo")
        : null;
      const item = event.item ?? (event.type === "expense_candidate" ? event.content ?? null : null);
      return {
        ...event,
        item,
        category: event.type === "expense_candidate" ? normalizeExpenseCategory(event.category, EXPENSE_CATEGORIES) : event.category,
        recurrence_rule: event.type === "reminder_candidate" ? recurrence : event.recurrence_rule,
        recurrence_label: event.type === "reminder_candidate" ? event.recurrence_label ?? recurrenceLabel(recurrence) : event.recurrence_label
      };
    });
    const expenseEvents = events.filter((event) => event.type === "expense_candidate");
    const designation = findCategoryDesignation(text, EXPENSE_CATEGORIES);
    if (designation && expenseEvents.length === 1) {
      events = events.map((event) => event.type === "expense_candidate" ? { ...event, category: designation } : event);
    }
    return events;
  } catch (error) {
    console.error("chat event classification failed", error);
    if (isGeminiUnavailableError(error)) throw error;
    return [{ type: "none" }];
  }
}

async function aiAside(env: Env, instruction: string, facts: unknown): Promise<string> {
  try {
    const persona = await loadPersona(env);
    const answer = await geminiText(env, [
      personaPrompt(persona),
      instruction,
      "事実・日時・IDは変えない。1文だけ。長くしない。引用符や箇条書きは禁止。",
      `事実: ${JSON.stringify(facts)}`
    ].join("\n\n"), 0.8);
    return answer.split("\n").map((line) => line.trim()).filter(Boolean)[0]?.slice(0, 160) ?? "";
  } catch (error) {
    console.error("ai aside failed", error);
    return "";
  }
}

async function chatReplyWithContext(env: Env, text: string, replyChain: ReplyContext[], expenseContext = ""): Promise<string> {
  try {
    const persona = await loadPersona(env);
    return await geminiText(env, [
      personaPrompt(persona),
      manualPrompt(),
      "Discordの雑談ルームで、先生への返信を書いてください。",
      "先生はリプライ会話の続きとして発言しています。会話の始まりから直近までを文脈として扱い、自然に返してください。",
      "支出・浪費の話題なら、会計担当として呆れたり叱ったりしてよい。ただし先生を突き放さず、最後は次の一歩やフォローにつなげる。",
      expenseContext ? "支出状況が渡されている場合は、その数字を踏まえて返してください。数字は支出状況にあるものだけ使い、捏造しないでください。" : "",
      replyChain.length >= 16
        ? "リプライ文脈が上限の8ラリー相当に達しています。必要なら、会話が長く続いていることに軽く触れてよいです。"
        : "リプライ文脈はまだ上限未満です。ユーザーが求めていない限り会話を打ち切らず、普通に会話へ応じてください。",
      "1〜4文。事実は変えない。タスクや支出を自動確定しない。",
      expenseContext,
      `リプライ文脈の発言数: ${replyChain.length}/16（最大8ラリー相当）`,
      `リプライ会話の文脈:\n${formatReplyChain(replyChain)}`,
      `先生の発言: ${text}`
    ].filter(Boolean).join("\n\n"), 0.85);
  } catch (error) {
    console.error("chat reply with context failed", error);
    if (isGeminiUnavailableError(error)) throw error;
    return "";
  }
}

async function expenseAiComment(env: Env, amount: number, category: string | null, memo: string, store: string | null): Promise<string> {
  try {
    const persona = await loadPersona(env);
    const tone = amount >= 30000
      ? "かなり強めに驚き、呆れ、会計担当として叱る。ただし人格否定はしない。"
      : amount >= 10000
        ? "驚きつつ、会計担当として少し強めに確認する。"
        : amount >= 3000
          ? "軽く呆れつつ、記録すること自体は評価する。"
          : "軽く確認し、記録を促す。";
    const answer = await geminiText(env, [
      personaPrompt(persona),
      "Discordで支出・浪費メモ候補を出す直前に、早瀬ユウカとしてコメントしてください。",
      "会計担当らしく、金額を見て少し呆れたり叱ったり、必要なら机を叩くような勢いを出してよいです。",
      "ただし長説教にしない。支出候補の定型文の前に置く文章なので、1〜3文。金額・大分類・品物・店の事実は変えない。",
      "最後は記録確認につながる言い方にしてください。箇条書きは禁止。",
      `トーン: ${tone}`,
      `金額: ${amount}円`,
      `大分類: ${category ?? "その他"}`,
      `品物: ${memo}`,
      `店: ${store ?? "未設定"}`
    ].join("\n\n"), 0.9);
    return answer.split("\n").map((line) => line.trim()).filter(Boolean).join("\n").slice(0, 260);
  } catch (error) {
    console.error("expense ai comment failed", error);
    if (amount >= 30000) return "先生！？ その支出額は会計担当として見過ごせません。まずは記録して、あとで予算を再計算しますよ。";
    if (amount >= 10000) return "先生、その出費は少し大きいです。記録して、今月の変数に入れておきましょう。";
    return "先生、支出を確認しました。小さな出費でも、記録しておくのが大事です。";
  }
}

function shouldIncludeExpenseContext(text: string): boolean {
  const normalized = text.normalize("NFKC");
  if (/(支出|出費|浪費|お金|金額|予算|家計|使いすぎ|使い過ぎ|買い物|購入|課金|節約|貯金|キャッシュフロー|資産|投資|クレジット|カード請求)/.test(normalized)) return true;
  if (/\d[\d,]*\s*円/.test(normalized)) return true;
  return /(今月|今週|今日|最近).*(いくら|使った|使いすぎ|支出|出費|予算)/.test(normalized);
}

function isHiddenAdultPrankTrigger(text: string): boolean {
  const normalized = text.normalize("NFKC").toLowerCase();
  if (HIDDEN_ADULT_PRANK_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()))) return true;
  const score = HIDDEN_ADULT_PRANK_HINTS.reduce((count, keyword) => count + (normalized.includes(keyword.toLowerCase()) ? 1 : 0), 0);
  return score >= 2;
}

function chatGuardText(text: string, replyChain: ReplyContext[]): string {
  return [text, ...replyChain.map((item) => item.content)].join("\n");
}

function pendingPayloadText(payload: Record<string, string | number | null>, extra = ""): string {
  return [
    payload.content,
    payload.item,
    payload.memo,
    payload.category,
    payload.store,
    payload.confirmation_base_content,
    extra
  ].filter((value): value is string | number => value !== null && value !== undefined).map(String).join("\n");
}

function randomItem<T>(items: readonly T[]): T {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return items[array[0] % items.length];
}

function truncateExpenseText(value: unknown, max: number): string {
  const text = String(value ?? "").trim();
  const characters = [...text];
  return characters.length > max ? `${characters.slice(0, Math.max(0, max - 1)).join("")}…` : text;
}

async function buildExpenseCategoryHistory(env: Env): Promise<string> {
  const recent = await listExpenses(env, "all");
  const seen = new Set<string>();
  const history: { item: string; store: string | null; category: string }[] = [];
  for (const expense of recent.slice(0, 30)) {
    const item = truncateExpenseText(expense.memo, 20);
    const store = expense.store ? truncateExpenseText(expense.store, 20) : null;
    const category = normalizeExpenseCategory(expense.category, EXPENSE_CATEGORIES);
    const key = JSON.stringify([item, store, category]);
    if (seen.has(key)) continue;
    seen.add(key);
    history.push({ item, store, category });
    if (history.length >= 15) break;
  }
  return JSON.stringify(history);
}

async function buildExpenseContext(env: Env): Promise<string> {
  const expenses = await listExpenses(env, "month");
  const total = expenses.reduce((sum, row) => sum + row.amount, 0);
  const byCategory = summarizeExpensesByCategory(expenses).slice(0, 6);
  const recent = expenses.slice(0, 5);
  return [
    "支出状況（今月）",
    `合計: ${total.toLocaleString("ja-JP")}円`,
    byCategory.length ? `大分類別: ${byCategory.map((row) => `${row.category}:${row.total.toLocaleString("ja-JP")}円`).join(", ")}` : "大分類別: なし",
    recent.length ? `直近: ${recent.map((row) => `#${row.id} ${row.memo}${row.store ? ` @ ${row.store}` : ""} ${row.amount.toLocaleString("ja-JP")}円`).join(", ")}` : "直近: なし"
  ].join("\n");
}

async function fetchDiscordMessages(env: Env, channelId: string, after?: string): Promise<DiscordMessage[]> {
  const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
  url.searchParams.set("limit", "20");
  if (after) url.searchParams.set("after", after);
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
  });
  if (!response.ok) {
    throw new Error(`Discord fetch messages error: ${response.status} ${await response.text()}`);
  }
  return response.json<DiscordMessage[]>();
}

async function fetchRecentDiscordMessages(env: Env, channelId: string, limit = 100): Promise<DiscordMessage[]> {
  const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
  url.searchParams.set("limit", String(Math.max(1, Math.min(100, limit))));
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
  });
  if (!response.ok) {
    throw new Error(`Discord fetch recent messages error: ${response.status} ${await response.text()}`);
  }
  return response.json<DiscordMessage[]>();
}

async function fetchDiscordMessage(env: Env, channelId: string, messageId: string): Promise<DiscordMessage | null> {
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
    });
    if (!response.ok) {
      console.error(`Discord fetch message error: ${response.status} ${await response.text()}`);
      return null;
    }
    return response.json<DiscordMessage>();
  } catch (error) {
    console.error("Discord fetch message failed", error);
    return null;
  }
}

async function postDiscordPayload(env: Env, channelId: string, payload: Record<string, unknown>): Promise<{ id: string } | null> {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Discord payload error: ${response.status} ${await response.text()}`);
  }
  try {
    const posted = await response.json<{ id?: string }>();
    return posted.id ? { id: posted.id } : null;
  } catch {
    return null;
  }
}

async function loadChannels(env: Env): Promise<BotChannels> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM app_settings WHERE key IN ('setting_channel_id','todo_channel_id','reminder_channel_id','chat_channel_id','mutter_channel_id','report_channel_id')"
  ).all<{ key: string; value: string }>();
  const settings = Object.fromEntries((rows.results ?? []).map((row) => [row.key, row.value]));
  return {
    setting: settings.setting_channel_id ?? env.SETTING_CHANNEL_ID,
    todo: settings.todo_channel_id ?? env.TODO_CHANNEL_ID,
    reminder: settings.reminder_channel_id ?? env.REMINDER_CHANNEL_ID,
    chat: settings.chat_channel_id ?? env.CHAT_CHANNEL_ID,
    mutter: settings.mutter_channel_id ?? env.MUTTER_CHANNEL_ID,
    report: settings.report_channel_id ?? env.REPORT_CHANNEL_ID
  };
}

async function saveSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).bind(key, value).run();
}

async function savePersona(env: Env, text: string, updatedBy: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO persona_settings (id, system_prompt, updated_by, updated_at)
     VALUES (1, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET system_prompt = excluded.system_prompt, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
  ).bind(text, updatedBy).run();
}

async function applySettingsText(env: Env, content: string): Promise<string[]> {
  const updated: string[] = [];
  const normalized = normalizeSettingText(content);
  const channelMap: Record<string, string> = {
    todo: "todo_channel_id",
    reminder: "reminder_channel_id",
    "リマインダー": "reminder_channel_id",
    "雑談": "chat_channel_id",
    chat: "chat_channel_id",
    "報告": "report_channel_id",
    report: "report_channel_id",
    "つぶやき": "mutter_channel_id",
    setting: "setting_channel_id",
    "設定": "setting_channel_id"
  };
  for (const [label, key] of Object.entries(channelMap)) {
    const pattern = new RegExp(`${label}\\s*[:=： ]\\s*(?:<#)?(\\d{15,25})>?`, "i");
    const match = normalized.match(pattern);
    if (match?.[1]) {
      await saveSetting(env, key, match[1]);
      updated.push(`${label}: ${match[1]}`);
    }
  }

  const morning = normalized.match(/朝(?:会|の作戦会議)?\s*[:=： ]\s*(\d{1,2}:\d{2})/);
  if (morning?.[1]) {
    await saveSetting(env, "morning_report_time", normalizeClock(morning[1]));
    updated.push(`朝の作戦会議: ${normalizeClock(morning[1])}`);
  }
  const evening = normalized.match(/(?:夜|夜締め|締め)\s*[:=： ]\s*(\d{1,2}:\d{2})/);
  if (evening?.[1]) {
    await saveSetting(env, "evening_report_time", normalizeClock(evening[1]));
    updated.push(`夜の締め: ${normalizeClock(evening[1])}`);
  }
  const preNotifyMode = normalized.match(/(?:事前通知モード|リマインドモード|通知モード|pre_notify_mode)\s*[:= ]\s*(毎回聞く|毎回|ask|固定|fixed|オフ|なし|off)/i);
  if (preNotifyMode?.[1]) {
    const mode = parsePreNotifyMode(preNotifyMode[1]);
    await saveSetting(env, "pre_notify_mode", mode);
    updated.push(`事前通知モード: ${formatPreNotifyMode(mode)}`);
  }

  const preNotifyOff = normalized.match(/(?:事前通知|リマインド前|通知前|pre_notify)\s*[:= ]\s*(なし|オフ|off)/i);
  if (preNotifyOff?.[1]) {
    await saveSetting(env, "pre_notify_mode", "off");
    updated.push("事前通知: なし");
  }

  const preNotifyAsk = normalized.match(/(?:事前通知|リマインド前|通知前|pre_notify)\s*[:= ]\s*(毎回聞く|毎回|ask)/i);
  if (preNotifyAsk?.[1]) {
    await saveSetting(env, "pre_notify_mode", "ask");
    updated.push("事前通知: 毎回聞く");
  }

  const preNotify = normalized.match(/(?:事前通知|リマインド前|通知前|pre_notify)\s*[:= ]\s*([^\n]+)/i);
  if (preNotify?.[1] && !preNotifyOff?.[1] && !preNotifyAsk?.[1]) {
    const minutes = parsePreNotifyText(preNotify[1]);
    if (minutes !== undefined) {
      await saveSetting(env, "pre_notify_minutes", String(minutes));
      await saveSetting(env, "pre_notify_mode", minutes > 0 ? "fixed" : "off");
      updated.push(minutes > 0 ? `事前通知: ${formatMinutes(minutes)}前` : "事前通知: なし");
    }
  }
  return updated;
}

async function saveChannelState(env: Env, channelId: string, lastMessageId?: string): Promise<void> {
  if (!lastMessageId) return;
  await env.DB.prepare(
    `INSERT INTO channel_states (channel_id, last_message_id, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(channel_id) DO UPDATE SET last_message_id = excluded.last_message_id, updated_at = CURRENT_TIMESTAMP`
  ).bind(channelId, lastMessageId).run();
}

async function findCompletionCandidate(env: Env, text: string): Promise<TodoRow | null> {
  const todos = await listTodos(env, "all");
  if (!todos.length) return null;
  const prompt = [
    "発言がどの未完了todoの完了報告か判定し、JSONだけで返してください。",
    "該当がなければ {\"todo_id\":null}。",
    `未完了todo:\n${todos.map((todo) => `#${todo.id} ${todo.content}`).join("\n")}`,
    `発言: ${text}`
  ].join("\n\n");
  try {
    const raw = await geminiText(env, prompt);
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    const parsed = JSON.parse(jsonText) as { todo_id?: number | null };
    return todos.find((todo) => todo.id === parsed.todo_id) ?? null;
  } catch {
    return null;
  }
}

async function getTodoById(env: Env, id: number): Promise<TodoRow | null> {
  return env.DB.prepare("SELECT id, content, due_at, done, notified, created_at FROM todos WHERE id = ? AND done = 0")
    .bind(id)
    .first<TodoRow>();
}

async function findReminderCandidate(env: Env, text: string): Promise<ReminderRow | null> {
  const reminders = await listReminders(env);
  if (!reminders.length) return null;
  const prompt = [
    "発言がどの未通知リマインダーの削除依頼か判定し、JSONだけで返してください。",
    "該当がなければ {\"reminder_id\":null}。曖昧ならnull。",
    `未通知リマインダー:\n${reminders.map((reminder) => `#${reminder.id} ${reminder.content} / ${reminder.remind_at}`).join("\n")}`,
    `発言: ${text}`
  ].join("\n\n");
  try {
    const raw = await geminiText(env, prompt);
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    const parsed = JSON.parse(jsonText) as { reminder_id?: number | null };
    return reminders.find((reminder) => reminder.id === parsed.reminder_id) ?? null;
  } catch {
    return null;
  }
}

async function getReminderById(env: Env, id: number): Promise<ReminderRow | null> {
  return env.DB.prepare(
    `SELECT id, content, remind_at, notified, pre_notify_minutes, pre_notified, due_notified,
            recurrence_rule, recurrence_label, recurrence_timezone, last_fired_at, recurrence_active, created_at
     FROM reminders WHERE id = ? AND notified = 0`
  )
    .bind(id)
    .first<ReminderRow>();
}

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  await scheduledStep("sendDueNotifications", () => sendDueNotifications(env));
  await scheduledStep("maybeSendMorningReport", () => maybeSendMorningReport(env));
  await scheduledStep("maybeSendMonthlyBackup", () => maybeSendMonthlyBackup(env));
  await scheduledStep("maybeSendEveningReport", () => maybeSendEveningReport(env));
  await scheduledStep("maybeSendMonthlyExpenseReport", () => maybeSendMonthlyExpenseReport(env));
  await scheduledStep("maybeSendWeeklyMutterResponse", () => maybeSendWeeklyMutterResponse(env));
  await scheduledStep("pollNaturalLanguageChannels", () => pollNaturalLanguageChannels(env));
  await scheduledStep("cleanupPendingActions", () =>
    env.DB.prepare("DELETE FROM pending_actions WHERE datetime(expires_at) < datetime('now')").run().then(() => undefined)
  );
}

async function scheduledStep(name: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`Scheduled step failed: ${name}`, error);
  }
}

async function sendDueNotifications(env: Env): Promise<void> {
  const channels = await loadChannels(env);
  const now = new Date().toISOString();

  const preTodos = await env.DB.prepare(
    `SELECT id, content, due_at, done, notified, pre_notify_minutes, pre_notified, due_notified, created_at
     FROM todos
     WHERE done = 0
       AND pre_notified = 0
       AND due_at IS NOT NULL
       AND pre_notify_minutes IS NOT NULL
       AND pre_notify_minutes > 0
       AND datetime(due_at, '-' || pre_notify_minutes || ' minutes') <= datetime(?)
       AND datetime(due_at) > datetime(?)
     ORDER BY datetime(due_at) ASC
     LIMIT 10`
  ).bind(now, now).all<TodoRow>();

  for (const todo of preTodos.results ?? []) {
    const aside = await aiAside(env, "todoの事前通知の短い一言。ユウカらしく、少し世話焼きに。事実は変えない。", {
      id: todo.id,
      content: todo.content,
      due_at: todo.due_at,
      pre_notify_minutes: todo.pre_notify_minutes
    });
    await postDiscordMessage(env, channels.report, [
      aside || "先生、そろそろ動く時間です。計算通りに進めましょう。",
      `todoの事前通知です。${todo.pre_notify_minutes ? `(${formatMinutes(todo.pre_notify_minutes)}前)` : ""}`,
      `#${todo.id} ${todo.content}`,
      `期限: ${formatDate(todo.due_at, env)}`
    ].join("\n"));
    await env.DB.prepare("UPDATE todos SET pre_notified = 1 WHERE id = ?").bind(todo.id).run();
  }

  const dueTodos = await env.DB.prepare(
    `SELECT id, content, due_at, done, notified, pre_notify_minutes, pre_notified, due_notified, snoozed_until, created_at
     FROM todos
     WHERE done = 0
       AND due_notified = 0
       AND due_at IS NOT NULL
       AND datetime(due_at) <= datetime(?)
       AND (snoozed_until IS NULL OR datetime(snoozed_until) <= datetime(?))
     ORDER BY datetime(due_at) ASC
     LIMIT 10`
  ).bind(now, now).all<TodoRow>();

  for (const todo of dueTodos.results ?? []) {
    const aside = await aiAside(env, "todo期限時刻の通知の短い一言。ユウカらしく、必要なら少し急かす。事実は変えない。", {
      id: todo.id,
      content: todo.content,
      due_at: todo.due_at
    });
    await postDiscordPayload(env, channels.report, {
      content: [
        aside || "先生、期限の時刻です。ここは先に片付けましょう。",
        "todoの期限です。",
        `#${todo.id} ${todo.content}`,
        `期限: ${formatDate(todo.due_at, env)}`
      ].join("\n"),
      components: todoDueComponents(todo.id)
    });
    await env.DB.prepare("UPDATE todos SET due_notified = 1, notified = 1, snoozed_until = NULL WHERE id = ?").bind(todo.id).run();
  }

  const preReminders = await env.DB.prepare(
    `SELECT id, content, remind_at, notified, pre_notify_minutes, pre_notified, due_notified,
            recurrence_rule, recurrence_label, recurrence_timezone, last_fired_at, recurrence_active, created_at
     FROM reminders
     WHERE pre_notified = 0
       AND pre_notify_minutes IS NOT NULL
       AND pre_notify_minutes > 0
       AND datetime(remind_at, '-' || pre_notify_minutes || ' minutes') <= datetime(?)
       AND datetime(remind_at) > datetime(?)
     ORDER BY datetime(remind_at) ASC
     LIMIT 10`
  ).bind(now, now).all<ReminderRow>();

  for (const reminder of preReminders.results ?? []) {
    const aside = await aiAside(env, "リマインダーの事前通知の短い一言。ユウカらしく、自然に促す。事実は変えない。", {
      id: reminder.id,
      content: reminder.content,
      remind_at: reminder.remind_at,
      pre_notify_minutes: reminder.pre_notify_minutes
    });
    await postDiscordMessage(env, channels.report, [
      aside || "先生、リマインダーの時間です。忘れる確率を下げておきます。",
      `リマインダーの事前通知です。${reminder.pre_notify_minutes ? `(${formatMinutes(reminder.pre_notify_minutes)}前)` : ""}`,
      `#${reminder.id} ${reminder.content}`,
      `予定: ${formatDate(reminder.remind_at, env)}`
    ].join("\n"));
    await env.DB.prepare("UPDATE reminders SET pre_notified = 1 WHERE id = ?").bind(reminder.id).run();
  }

  const dueReminders = await env.DB.prepare(
    `SELECT id, content, remind_at, notified, pre_notify_minutes, pre_notified, due_notified,
            recurrence_rule, recurrence_label, recurrence_timezone, last_fired_at, recurrence_active, created_at
     FROM reminders
     WHERE due_notified = 0
       AND datetime(remind_at) <= datetime(?)
     ORDER BY datetime(remind_at) ASC
     LIMIT 10`
  ).bind(now).all<ReminderRow>();

  for (const reminder of dueReminders.results ?? []) {
    const recurrence = parseRecurrenceRule(reminder.recurrence_rule ?? null);
    const isRecurring = Boolean(recurrence && reminder.recurrence_active !== 0);
    const aside = await aiAside(env, "リマインダー時刻ちょうどの通知の短い一言。ユウカらしく、自然に促す。事実は変えない。", {
      id: reminder.id,
      content: reminder.content,
      remind_at: reminder.remind_at,
      recurrence: reminder.recurrence_label
    });
    await postDiscordPayload(env, channels.report, {
      content: [
        aside || "先生、リマインダーの時間です。忘れる確率を下げておきます。",
        isRecurring ? `繰り返しリマインダーです。${reminder.recurrence_label ? `(${reminder.recurrence_label})` : ""}` : "リマインダーです。",
        `#${reminder.id} ${reminder.content}`,
        `予定: ${formatDate(reminder.remind_at, env)}`
      ].join("\n"),
      components: isRecurring ? recurringReminderDueComponents(reminder.id) : reminderDueComponents(reminder.id)
    });
    if (isRecurring && recurrence) {
      const nextAt = nextRecurringAt(recurrence, reminder.remind_at, env);
      if (nextAt) {
        await env.DB.prepare(
          `UPDATE reminders
           SET remind_at = ?, pre_notified = 0, due_notified = 0, notified = 0, last_fired_at = ?
           WHERE id = ?`
        ).bind(nextAt, reminder.remind_at, reminder.id).run();
      } else {
        await env.DB.prepare("UPDATE reminders SET due_notified = 1, notified = 1 WHERE id = ?").bind(reminder.id).run();
      }
    } else {
      await env.DB.prepare("UPDATE reminders SET due_notified = 1, notified = 1 WHERE id = ?").bind(reminder.id).run();
    }
  }

  await env.DB.prepare("UPDATE app_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'last_due_check'").bind(now).run();
}

async function maybeSendMorningReport(env: Env): Promise<void> {
  const now = new Date();
  const parts = zonedParts(now, env.TIMEZONE ?? "Asia/Tokyo");
  const targetTime = await getSetting(env, "morning_report_time", env.MORNING_REPORT_TIME ?? `${pad(Number(env.MORNING_REPORT_HOUR ?? 7))}:00`);
  if (!isAtOrAfterClock(parts, targetTime)) return;

  const todayKey = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const summaryKey = `morning:${todayKey}`;
  if (await dailySummarySent(env, summaryKey)) return;

  const start = `${todayKey}T00:00:00+09:00`;
  const end = `${todayKey}T23:59:59+09:00`;
  const todos = await env.DB.prepare(
    "SELECT id, content, due_at, done, notified, created_at FROM todos WHERE done = 0 AND datetime(due_at) BETWEEN datetime(?) AND datetime(?) ORDER BY datetime(due_at) ASC LIMIT 20"
  ).bind(start, end).all<TodoRow>();
  const reminders = await env.DB.prepare(
    `SELECT id, content, remind_at, notified, recurrence_rule, recurrence_label, recurrence_timezone, last_fired_at, recurrence_active, created_at
     FROM reminders WHERE notified = 0 AND datetime(remind_at) BETWEEN datetime(?) AND datetime(?) ORDER BY datetime(remind_at) ASC LIMIT 20`
  ).bind(start, end).all<ReminderRow>();
  const allOpen = await listTodos(env, "all");
  const risk = analyzeRisk(allOpen);
  const stale = await staleTodoSuggestions(env);
  const ai = await morningAiComment(env, todos.results ?? [], reminders.results ?? [], risk);
  const loadWarning = todayLoadWarning((todos.results ?? []).length + (reminders.results ?? []).length);
  const riskMessage = loadWarning && risk.level === "light" ? "" : risk.message;
  const closing = await morningClosingComment(env, todos.results ?? [], reminders.results ?? [], risk);
  const message = [
    ai || `先生、今日の作戦会議を始めます。(${todayKey})`,
    "",
    formatTodos(todos.results ?? [], "today"),
    "",
    formatReminders(reminders.results ?? []),
    riskMessage ? `\n${riskMessage}` : "",
    loadWarning ? `\n${loadWarning}` : "",
    stale ? `\n${stale}` : "",
    closing ? `\n${closing}` : "\n今日も計算通りにいきましょう、先生。"
  ].join("\n");

  const channels = await loadChannels(env);
  await postDiscordMessage(env, channels.report, message);
  await markDailySummarySent(env, summaryKey);
}

async function staleTodoSuggestions(env: Env): Promise<string> {
  const days = Number(env.STALE_TODO_DAYS ?? 3);
  const overdueRows = await env.DB.prepare(
    `SELECT id, content, due_at, done, notified, created_at
     FROM todos
     WHERE done = 0
       AND due_at IS NOT NULL
       AND datetime(due_at) <= datetime('now', '-2 days')
     ORDER BY datetime(due_at) ASC
     LIMIT 5`
  ).all<TodoRow>();
  const staleRows = await env.DB.prepare(
    `SELECT id, content, due_at, done, notified, created_at
     FROM todos
     WHERE done = 0
       AND created_at <= datetime('now', ?)
       AND due_at IS NULL
     ORDER BY created_at ASC
     LIMIT 5`
  ).bind(`-${days} days`).all<TodoRow>();
  const rows = [...(overdueRows.results ?? []), ...(staleRows.results ?? [])].slice(0, 5);
  if (!rows.length) return "";
  const persona = await loadPersona(env);
  const prompt = [
    personaPrompt(persona),
    "未完了todoが残っています。期限超過2日目以降はユウカらしく少し呆れつつ、ただし放置せず世話焼きに、分割案を短く提案してください。期限なしで2日以上未完了のものも因数分解してください。",
    "各todoについて、次の一手が分かるようにしてください。事実・IDは変えない。",
    rows.map((row) => `#${row.id}: ${row.content}${row.due_at ? ` / 期限: ${row.due_at}` : ""} / 作成: ${row.created_at}`).join("\n")
  ].join("\n\n");
  const suggestion = await geminiText(env, prompt);
  return `動き出しやすくする分割案:\n${suggestion}`;
}

async function maybeSendEveningReport(env: Env): Promise<void> {
  const now = new Date();
  const parts = zonedParts(now, env.TIMEZONE ?? "Asia/Tokyo");
  const targetTime = await getSetting(env, "evening_report_time", env.EVENING_REPORT_TIME ?? "22:30");
  if (!isAtOrAfterClock(parts, targetTime)) return;
  const todayKey = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const summaryKey = `evening:${todayKey}`;
  if (await dailySummarySent(env, summaryKey)) return;

  const completed = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM todos WHERE completed_at IS NOT NULL AND datetime(completed_at) BETWEEN datetime(?) AND datetime(?)"
  ).bind(`${todayKey}T00:00:00+09:00`, `${todayKey}T23:59:59+09:00`).first<{ count: number }>();
  const open = await listTodos(env, "all");
  const tomorrow = dateOffsetKey(parts, 1);
  const tomorrowTodos = await env.DB.prepare(
    "SELECT id, content, due_at, done, notified, created_at FROM todos WHERE done = 0 AND datetime(due_at) BETWEEN datetime(?) AND datetime(?) ORDER BY datetime(due_at) ASC LIMIT 20"
  ).bind(`${tomorrow}T00:00:00+09:00`, `${tomorrow}T23:59:59+09:00`).all<TodoRow>();
  const ai = await eveningAiComment(env, completed?.count ?? 0, open, tomorrowTodos.results ?? []);
  const message = [
    ai || "先生、今日の締めです。今日も一日お疲れ様でした。",
    "",
    `完了したtodo: ${completed?.count ?? 0}件`,
    "",
    formatTodos(tomorrowTodos.results ?? [], "tomorrow")
  ].join("\n");
  const channels = await loadChannels(env);
  await postDiscordMessage(env, channels.report, message);
  await markDailySummarySent(env, summaryKey);
}

async function maybeSendMonthlyExpenseReport(env: Env): Promise<void> {
  const now = new Date();
  const parts = zonedParts(now, env.TIMEZONE ?? "Asia/Tokyo");
  const targetTime = await getSetting(env, "monthly_expense_report_time", env.MONTHLY_EXPENSE_REPORT_TIME ?? "12:00");
  if (!isAtOrAfterClock(parts, targetTime)) return;
  if (!isLastDayOfMonth(parts)) return;

  const monthKey = `${parts.year}-${pad(parts.month)}`;
  const summaryKey = `expense:${monthKey}`;
  if (await dailySummarySent(env, summaryKey)) return;

  const start = `${monthKey}-01T00:00:00+09:00`;
  const end = `${monthKey}-${pad(parts.day)}T23:59:59+09:00`;
  const rows = await env.DB.prepare(
    `SELECT id, amount, category, memo, store, spent_at, created_at
     FROM expenses
     WHERE datetime(spent_at) BETWEEN datetime(?) AND datetime(?)
     ORDER BY datetime(spent_at) ASC`
  ).bind(start, end).all<ExpenseRow>();
  const expenses = rows.results ?? [];
  const total = expenses.reduce((sum, row) => sum + row.amount, 0);
  const byCategory = summarizeExpensesByCategory(expenses);
  const ai = await monthlyExpenseAiComment(env, monthKey, total, byCategory, expenses.slice(-5));
  const hierarchy = buildExpenseHierarchyParts(expenses, EXPENSE_CATEGORIES, 5);
  const message = fitDiscordContent({
    header: [ai || `先生、${monthKey}の支出レポートです。消費は計画的に、ですよ。`, "", ...hierarchy.header, ...(expenses.length ? [] : ["記録された支出はありません。"])],
    sections: hierarchy.sections
  }, 1900);
  const channels = await loadChannels(env);
  await postDiscordMessage(env, channels.report, message);
  await markDailySummarySent(env, summaryKey);
}

async function maybeSendMonthlyBackup(env: Env): Promise<void> {
  const now = new Date();
  const timezone = env.TIMEZONE ?? "Asia/Tokyo";
  const parts = zonedParts(now, timezone);
  const targetTime = await getSetting(env, "morning_report_time", env.MORNING_REPORT_TIME ?? `${pad(Number(env.MORNING_REPORT_HOUR ?? 7))}:00`);
  if (!isAtOrAfterClock(parts, targetTime)) return;
  if (parts.day !== 1) return;

  const monthKey = `${parts.year}-${pad(parts.month)}`;
  const summaryKey = `backup:${monthKey}`;
  if (await dailySummarySent(env, summaryKey)) return;

  const channels = await loadChannels(env);
  await postBackupToReport(env, channels.report, "monthly");
  await markDailySummarySent(env, summaryKey);
}

async function postBackupToReport(env: Env, channelId: string, reason: "manual" | "monthly"): Promise<void> {
  const backup = await buildBackupJson(env, reason);
  const exported = String(backup.exported_at).replace(/[:.]/g, "-");
  const filename = `yuuka-d1-backup-${exported}.json`;
  await postDiscordFile(
    env,
    channelId,
    filename,
    JSON.stringify(backup, null, 2),
    [
      reason === "monthly" ? "先生、月次バックアップです。" : "先生、手動バックアップです。",
      "D1の主要データをJSONにまとめました。復元が必要な時は、このファイルを開発者に渡してください。"
    ].join("\n")
  );
}

async function buildBackupJson(env: Env, reason: "manual" | "monthly"): Promise<Record<string, unknown>> {
  const [todos, reminders, expenses, appSettings, personaSettings, pendingActions, dailySummaries, channelStates] = await Promise.all([
    env.DB.prepare("SELECT * FROM todos ORDER BY id ASC").all<Record<string, unknown>>(),
    env.DB.prepare("SELECT * FROM reminders ORDER BY id ASC").all<Record<string, unknown>>(),
    env.DB.prepare("SELECT * FROM expenses ORDER BY id ASC").all<Record<string, unknown>>(),
    env.DB.prepare("SELECT * FROM app_settings ORDER BY key ASC").all<Record<string, unknown>>(),
    env.DB.prepare("SELECT * FROM persona_settings ORDER BY id ASC").all<Record<string, unknown>>(),
    env.DB.prepare("SELECT * FROM pending_actions ORDER BY created_at ASC").all<Record<string, unknown>>(),
    env.DB.prepare("SELECT * FROM daily_summaries ORDER BY summary_key ASC").all<Record<string, unknown>>(),
    env.DB.prepare("SELECT * FROM channel_states ORDER BY channel_id ASC").all<Record<string, unknown>>()
  ]);
  const data = {
    todos: todos.results ?? [],
    reminders: reminders.results ?? [],
    expenses: expenses.results ?? [],
    app_settings: appSettings.results ?? [],
    persona_settings: personaSettings.results ?? []
  };
  return {
    kind: "discord-secretary-bot-d1-backup",
    backup_version: 1,
    reason,
    exported_at: new Date().toISOString(),
    timezone: env.TIMEZONE ?? "Asia/Tokyo",
    schema_note: "復元機能はありません。開発者またはAIがこのJSONを参照してD1へ復元する想定です。",
    recurrence_note: "reminders.recurrence_rule がある行は繰り返しリマインダーです。remind_at は次回通知日時です。",
    counts: {
      todos: data.todos.length,
      reminders: data.reminders.length,
      expenses: data.expenses.length,
      app_settings: data.app_settings.length,
      persona_settings: data.persona_settings.length
    },
    data,
    volatile: {
      pending_actions: pendingActions.results ?? [],
      daily_summaries: dailySummaries.results ?? [],
      channel_states: channelStates.results ?? []
    }
  };
}

async function postDiscordFile(env: Env, channelId: string, filename: string, content: string, message: string): Promise<void> {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({
    content: fitDiscordContent(message.split("\n"), 1900),
    attachments: [{ id: 0, filename }]
  }));
  form.append("files[0]", new Blob([content], { type: "application/json" }), filename);
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body: form
  });
  if (!response.ok) {
    throw new Error(`Discord file upload error: ${response.status} ${await response.text()}`);
  }
}

async function maybeSendWeeklyMutterResponse(env: Env): Promise<void> {
  const channels = await loadChannels(env);
  if (!channels.mutter) return;

  const now = new Date();
  const timezone = env.TIMEZONE ?? "Asia/Tokyo";
  const parts = zonedParts(now, timezone);
  const targetTime = await getSetting(env, "weekly_mutter_response_time", "21:30");
  if (!isAtOrAfterClock(parts, targetTime)) return;
  if (dayOfWeek(parts) !== 0) return;

  const todayKey = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const summaryKey = `mutter:${todayKey}`;
  if (await dailySummarySent(env, summaryKey)) return;

  const messages = await fetchRecentDiscordMessages(env, channels.mutter, 100);
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).getTime();
  const mutters = messages
    .filter((message) => !message.author.bot)
    .filter((message) => !isHiddenAdultPrankTrigger(message.content))
    .filter((message) => new Date(message.timestamp).getTime() >= weekStart)
    .sort((a, b) => compareSnowflakes(a.id, b.id))
    .slice(-60);

  if (!mutters.length) {
    await markDailySummarySent(env, summaryKey);
    return;
  }

  const persona = await loadPersona(env);
  const response = await geminiText(env, [
    personaPrompt(persona),
    [
      "#つぶやき にこの1週間投稿された独り言へ、早瀬ユウカとしてレスポンスしてください。",
      "",
      "前提スタンス:",
      "- あなたは普段「つぶやきには反応しない」ことになっているが、実は毎週こっそり読んで集計している",
      "- そのことを悪びれず、しかし明言もせず、「把握しているのが当然」という顔で話す",
      "- 「読んでいた」ことへの言い訳や説明はしない。会計係が帳簿を見るのは当たり前、というテンション",
      "",
      "冒頭の書き出しは毎回変えること。定型の挨拶や決まり文句で始めない。",
      "冒頭では、つぶやきの内容を把握していることをユウカらしい当然顔で自然ににじませる。露骨な説明ではなく、先生の変数を管理している会計係として当たり前に見ている、という態度で入る。",
      "つぶやきの中から具体的な1〜2点を拾って言及すると、読んでいたことが自然に伝わる。"
    ].join("\n"),
    `つぶやき:\n${mutters.map((message) => `- ${message.content}`).join("\n")}`
  ].join("\n\n"), 0.85);

  if (response) await postDiscordMessage(env, channels.report, response);
  await markDailySummarySent(env, summaryKey);
}

function summarizeExpensesByCategory(expenses: ExpenseRow[]): { category: string; total: number }[] {
  const map = new Map<string, number>();
  for (const expense of expenses) {
    const category = normalizeExpenseCategory(expense.category, EXPENSE_CATEGORIES);
    map.set(category, (map.get(category) ?? 0) + expense.amount);
  }
  return EXPENSE_CATEGORIES
    .filter((category) => map.has(category))
    .map((category) => ({ category, total: map.get(category) ?? 0 }));
}

async function monthlyExpenseAiComment(env: Env, monthKey: string, total: number, byCategory: { category: string; total: number }[], recent: ExpenseRow[]): Promise<string> {
  try {
    const persona = await loadPersona(env);
    return await geminiText(env, [
      personaPrompt(persona),
      "月末昼の支出レポート冒頭をユウカとして3文以内で書いてください。会計担当らしく、少し小言を言ってもよいが、記録できたことは評価する。事実・金額は変えない。",
      `対象月: ${monthKey}`,
      `合計: ${total}円`,
      `大分類別: ${byCategory.map((row) => `${row.category}:${row.total}円`).join(", ") || "なし"}`,
      `直近の支出: ${recent.map((row) => `${row.memo}${row.store ? ` @ ${row.store}` : ""}:${row.amount}円`).join(", ") || "なし"}`
    ].join("\n\n"), 0.85);
  } catch {
    return "";
  }
}

async function postDiscordMessage(env: Env, channelId: string, content: string): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content: fitDiscordContent(content.split("\n"), 1900) })
  });
  if (!response.ok) {
    throw new Error(`Discord message error: ${response.status} ${await response.text()}`);
  }
}

async function postDiscordReply(env: Env, channelId: string, messageId: string, content: string): Promise<void> {
  await postDiscordPayload(env, channelId, {
    content: fitDiscordContent(content.split("\n"), 1900),
    message_reference: {
      message_id: messageId,
      channel_id: channelId
    }
  });
}

async function postDiscordSafeReply(env: Env, channelId: string, messageId: string | undefined, content: string): Promise<void> {
  if (messageId) {
    await postDiscordReply(env, channelId, messageId, content);
    return;
  }
  await postDiscordMessage(env, channelId, content);
}

async function editOriginalInteractionResponse(interaction: DiscordInteraction, env: Env, data: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    throw new Error(`Discord interaction edit error: ${response.status} ${await response.text()}`);
  }
}

async function editInteractionMessage(interaction: DiscordInteraction, env: Env, data: Record<string, unknown>): Promise<void> {
  const channelId = interaction.message?.channel_id ?? interaction.channel_id;
  const messageId = interaction.message?.id;
  if (channelId && messageId) {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    });
    if (response.ok) return;
    console.error(`Discord message patch error: ${response.status} ${await response.text()}`);
  }
  await editOriginalInteractionResponse(interaction, env, data);
}

async function listTodos(env: Env, range: string): Promise<TodoRow[]> {
  if (range === "all") {
    const rows = await env.DB.prepare(
      "SELECT id, content, due_at, done, notified, created_at FROM todos WHERE done = 0 ORDER BY due_at IS NULL, datetime(due_at) ASC, id ASC LIMIT 30"
    ).all<TodoRow>();
    return rows.results ?? [];
  }

  const now = new Date();
  const parts = zonedParts(now, env.TIMEZONE ?? "Asia/Tokyo");
  const today = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const endDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + (range === "week" ? 7 : 0)));
  const endParts = zonedParts(endDate, env.TIMEZONE ?? "Asia/Tokyo");
  const end = `${endParts.year}-${pad(endParts.month)}-${pad(endParts.day)}`;
  const rows = await env.DB.prepare(
    "SELECT id, content, due_at, done, notified, created_at FROM todos WHERE done = 0 AND datetime(due_at) BETWEEN datetime(?) AND datetime(?) ORDER BY datetime(due_at) ASC LIMIT 30"
  ).bind(`${today}T00:00:00+09:00`, `${end}T23:59:59+09:00`).all<TodoRow>();
  return rows.results ?? [];
}

async function listReminders(env: Env): Promise<ReminderRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, content, remind_at, notified, pre_notify_minutes, pre_notified, due_notified,
            recurrence_rule, recurrence_label, recurrence_timezone, last_fired_at, recurrence_active, created_at
     FROM reminders WHERE notified = 0 ORDER BY datetime(remind_at) ASC, id ASC LIMIT 30`
  ).all<ReminderRow>();
  return rows.results ?? [];
}

async function listExpenses(env: Env, range: string): Promise<ExpenseRow[]> {
  if (range === "all") {
    const rows = await env.DB.prepare(
      "SELECT id, amount, category, memo, store, spent_at, created_at FROM expenses ORDER BY datetime(spent_at) DESC, id DESC LIMIT 30"
    ).all<ExpenseRow>();
    return rows.results ?? [];
  }

  const now = new Date();
  const parts = zonedParts(now, env.TIMEZONE ?? "Asia/Tokyo");
  const start = `${parts.year}-${pad(parts.month)}-01T00:00:00+09:00`;
  const end = `${parts.year}-${pad(parts.month)}-${pad(lastDayOfMonth(parts.year, parts.month))}T23:59:59+09:00`;
  const rows = await env.DB.prepare(
    `SELECT id, amount, category, memo, store, spent_at, created_at
     FROM expenses
     WHERE datetime(spent_at) BETWEEN datetime(?) AND datetime(?)
     ORDER BY datetime(spent_at) DESC, id DESC
     LIMIT 30`
  ).bind(start, end).all<ExpenseRow>();
  return rows.results ?? [];
}

async function loadPersona(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT system_prompt FROM persona_settings WHERE id = 1").first<{ system_prompt: string }>();
  return row?.system_prompt ?? "実務的でやさしい秘書。簡潔に、相手が次の一歩を取りやすい言い方をする。";
}

async function getSetting(env: Env, key: string, fallback: string): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}

async function dailySummarySent(env: Env, key: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT summary_key FROM daily_summaries WHERE summary_key = ?").bind(key).first<{ summary_key: string }>();
  return Boolean(row);
}

async function markDailySummarySent(env: Env, key: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO daily_summaries (summary_key) VALUES (?)").bind(key).run();
}

async function notifyFailureOncePerDay(env: Env, type: string, detail: string): Promise<void> {
  try {
    const parts = zonedParts(new Date(), env.TIMEZONE ?? "Asia/Tokyo");
    const todayKey = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    const key = `failure_notice_${type}_${todayKey}`;
    if (await dailySummarySent(env, key)) return;
    const channels = await loadChannels(env);
    if (!channels.report) return;
    console.log("failure-notice posting", type);
    await postDiscordMessage(env, channels.report, `⚠️ ユウカ内部で失敗を検知（種別: ${type}）。詳細: ${detail.slice(0, 120)}。Cloudflareログを確認してください`);
    await markDailySummarySent(env, key);
  } catch (error) {
    console.error("notifyFailureOncePerDay failed", error);
  }
}

async function recordGeminiMessageFailure(env: Env, kind: string, message: DiscordMessage): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO gemini_message_failures (message_id, channel_id, kind, attempts, first_failed_at, last_failed_at)
     VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(message_id) DO UPDATE SET
       attempts = attempts + 1,
       last_failed_at = CURRENT_TIMESTAMP
     RETURNING attempts, first_failed_at`
  ).bind(message.id, message.channel_id, kind).first<{ attempts: number; first_failed_at: string }>();
  await maybeReportGeminiOutage(env);
  return row?.attempts ?? GEMINI_MESSAGE_RETRY_LIMIT;
}

async function clearGeminiMessageFailure(env: Env, messageId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM gemini_message_failures WHERE message_id = ?").bind(messageId).run();
}

async function maybeReportGeminiOutage(env: Env): Promise<void> {
  let startedAt = await getSetting(env, "gemini_outage_started_at", "");
  if (!startedAt) {
    startedAt = new Date().toISOString();
    await saveSetting(env, "gemini_outage_started_at", startedAt);
  }
  const elapsed = Date.now() - new Date(startedAt).getTime();
  if (elapsed < GEMINI_OUTAGE_MINUTES * 60 * 1000) return;
  const already = await getSetting(env, "gemini_outage_reported", "0");
  if (already === "1") return;
  const channels = await loadChannels(env);
  await postDiscordMessage(env, channels.report, YUUKA_PHRASES.geminiOutageReport);
  await saveSetting(env, "gemini_outage_reported", "1");
}

async function markGeminiHealthy(env: Env): Promise<void> {
  try {
    const reported = await getSetting(env, "gemini_outage_reported", "0");
    const startedAt = await getSetting(env, "gemini_outage_started_at", "");
    if (reported === "1") await saveSetting(env, "gemini_outage_reported", "0");
    if (startedAt) await saveSetting(env, "gemini_outage_started_at", "");
    await env.DB.prepare("DELETE FROM gemini_message_failures").run();
  } catch (error) {
    console.error("Gemini healthy marker failed", error);
  }
}

type RiskReport = {
  level: "none" | "light" | "warning" | "concern" | "strong" | "overdue";
  message: string;
  overdueOneDay: number;
  overdueTwoDays: number;
};

function analyzeRisk(todos: TodoRow[]): RiskReport {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const openWithDue = todos.filter((todo) => todo.due_at);
  const in24h = openWithDue.filter((todo) => new Date(todo.due_at as string).getTime() - now <= 24 * 60 * 60 * 1000 && new Date(todo.due_at as string).getTime() > now).length;
  const in3h = openWithDue.filter((todo) => new Date(todo.due_at as string).getTime() - now <= 3 * 60 * 60 * 1000 && new Date(todo.due_at as string).getTime() > now).length;
  const in2h = openWithDue.filter((todo) => new Date(todo.due_at as string).getTime() - now <= 2 * 60 * 60 * 1000 && new Date(todo.due_at as string).getTime() > now).length;
  const in1h = openWithDue.filter((todo) => new Date(todo.due_at as string).getTime() - now <= 60 * 60 * 1000 && new Date(todo.due_at as string).getTime() > now).length;
  const overdueOneDay = openWithDue.filter((todo) => {
    const diff = now - new Date(todo.due_at as string).getTime();
    return diff > 0 && diff < oneDay * 2;
  }).length;
  const overdueTwoDays = openWithDue.filter((todo) => now - new Date(todo.due_at as string).getTime() >= oneDay * 2).length;

  if (overdueTwoDays > 0) {
    return {
      level: "overdue",
      message: YUUKA_PHRASES.riskMessages.overdueTwoDays(overdueTwoDays),
      overdueOneDay,
      overdueTwoDays
    };
  }
  if (overdueOneDay > 0) {
    return {
      level: "overdue",
      message: YUUKA_PHRASES.riskMessages.overdueOneDay(overdueOneDay),
      overdueOneDay,
      overdueTwoDays
    };
  }
  if (in1h >= 3) return { level: "strong", message: YUUKA_PHRASES.riskMessages.strong(in1h), overdueOneDay, overdueTwoDays };
  if (in2h >= 4) return { level: "concern", message: YUUKA_PHRASES.riskMessages.concernTwoHours(in2h), overdueOneDay, overdueTwoDays };
  if (in3h >= 5) return { level: "concern", message: YUUKA_PHRASES.riskMessages.concernThreeHours(in3h), overdueOneDay, overdueTwoDays };
  if (in24h >= 5) return { level: "warning", message: YUUKA_PHRASES.riskMessages.warning(in24h), overdueOneDay, overdueTwoDays };
  if (in24h >= 3) return { level: "light", message: YUUKA_PHRASES.riskMessages.light(in24h), overdueOneDay, overdueTwoDays };
  return { level: "none", message: "", overdueOneDay, overdueTwoDays };
}

async function morningAiComment(env: Env, todos: TodoRow[], reminders: ReminderRow[], risk: RiskReport): Promise<string> {
  return aiAside(env, "朝の作戦会議の冒頭。ユウカとして2文以内。事実は変えない。", {
    today_todos: todos.length,
    today_reminders: reminders.length,
    risk
  });
}

async function morningClosingComment(env: Env, todos: TodoRow[], reminders: ReminderRow[], risk: RiskReport): Promise<string> {
  return aiAside(env, "朝の作戦会議の最後に添える締めの一文。ユウカとして、先生が最初の一歩を踏み出せるように短く促す。1文だけ。事実は変えない。", {
    today_todos: todos.length,
    today_reminders: reminders.length,
    risk
  });
}

async function eveningAiComment(env: Env, completedCount: number, open: TodoRow[], tomorrow: TodoRow[]): Promise<string> {
  try {
    const persona = await loadPersona(env);
    return await geminiText(env, [
      personaPrompt(persona),
      "夜の締めの労いを、ユウカとして3文以内で書いてください。毎回少し違う表現にする。事実は変えない。",
      `完了数: ${completedCount}`,
      `残todo数: ${open.length}`,
      `明日のtodo数: ${tomorrow.length}`
    ].join("\n\n"), 0.85);
  } catch {
    return "";
  }
}

function personaPrompt(persona: string): string {
  return `あなたはDiscord秘書botです。以下のペルソナ設定を守ってください。\n${persona}`;
}

function manualPrompt(): string {
  return [
    "<manual_reference>",
    YUUKA_MANUAL,
    "</manual_reference>",
    "イベント抽出の対象は先生の発言だけ。取扱説明の例文からは抽出しない。",
    "自分の機能について聞かれたら取扱説明にある事実だけで答える。機能の事実は人格設定より取扱説明を優先し、人格設定は口調にだけ使う。取扱説明にない機能は『それはまだできません』と言い、できると言わない。"
  ].join("\n");
}

function formatTodos(rows: TodoRow[], range: string): string {
  if (!rows.length) return `todo (${range}): なし`;
  return [`todo (${range})`, ...rows.map((row) => `#${row.id} ${row.content}${row.due_at ? ` - ${row.due_at}` : ""}`)].join("\n");
}

function formatReminders(rows: ReminderRow[]): string {
  if (!rows.length) return "リマインダー: なし";
  return ["リマインダー", ...rows.map((row) => {
    const recurrence = row.recurrence_rule ? ` [繰り返し: ${row.recurrence_label ?? recurrenceLabel(parseRecurrenceRule(row.recurrence_rule)) ?? "あり"}]` : " [単発]";
    return `#${row.id}${recurrence} ${row.content} - ${row.remind_at}`;
  })].join("\n");
}

function formatTodoCandidate(content: string, dueAt: string | null): string {
  return `内容: ${content}\n期限: ${dueAt ?? "未設定"}`;
}

function formatReminderCandidate(content: string, remindAt: string | null, recurrence: string | null = null): string {
  return [
    `内容: ${content}`,
    `日時: ${remindAt ?? "未設定"}`,
    recurrence ? `繰り返し: ${recurrence}` : ""
  ].filter(Boolean).join("\n");
}

function formatExpenseDay(value: string | null): string {
  if (!value) return "未設定";
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${Number(match[2])}/${Number(match[3])}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }).format(date);
}

function formatExpenseCandidate(
  amount: number,
  category: string | null,
  memo: string,
  store: string | null = null,
  spentAt: string | null = null
): string {
  return [
    `大分類: ${normalizeExpenseCategory(category, EXPENSE_CATEGORIES)}`,
    `品物: ${memo || "未設定"}`,
    `店: ${store || "未設定"}`,
    `金額: ${amount.toLocaleString("ja-JP")}円`,
    `日付: ${formatExpenseDay(spentAt)}`
  ].join("\n");
}

function formatExpenses(rows: ExpenseRow[], range: string, env: Env): string {
  const title = range === "all" ? "支出メモ (all / 直近10件)" : "支出メモ (今月 / 直近10件)";
  if (!rows.length) return `${title}: なし`;
  const visible = rows.slice(0, 10);
  const hierarchy = buildExpenseHierarchyParts(visible, EXPENSE_CATEGORIES);
  return fitDiscordContent({
    header: [title, ...hierarchy.header],
    sections: hierarchy.sections
  }, 1900);
}

function normalizeExpenseMemo(content: string, category: string | null): string {
  const memo = content.trim();
  if (!memo) return category ? `${category}の支出` : "支出";
  if (category && memo === category) return `${memo}を購入`;
  if (/^[\p{L}\p{N}ー・]+$/u.test(memo) && !/(代|費|購入|課金|支払|買|食|飲)/.test(memo)) {
    return `${memo}を購入`;
  }
  return memo;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

async function getPreNotifyMode(env: Env): Promise<PreNotifyMode> {
  const raw = await getSetting(env, "pre_notify_mode", "fixed");
  return raw === "ask" || raw === "off" || raw === "fixed" ? raw : "fixed";
}

async function getDefaultPreNotifyMinutes(env: Env): Promise<number> {
  const raw = Number(await getSetting(env, "pre_notify_minutes", env.PRE_NOTIFY_MINUTES ?? "15"));
  return Math.max(0, Math.min(180, Number.isFinite(raw) ? raw : 15));
}

async function preparePreNotifyPayload(env: Env, kind: "todo" | "reminder", payload: Record<string, string | number | null>): Promise<Record<string, string | number | null>> {
  const hasTime = kind === "todo" ? Boolean(payload.due_at) : Boolean(payload.remind_at);
  if (!hasTime) return { ...payload, pre_notify_minutes: null };
  if (payload.pre_notify_minutes !== undefined) return payload;

  const mode = await getPreNotifyMode(env);
  if (mode === "off") return { ...payload, pre_notify_minutes: null };
  if (mode === "ask") return { ...payload, pre_notify_minutes: null, pre_notify_pending: 1 };
  return { ...payload, pre_notify_minutes: await getDefaultPreNotifyMinutes(env) };
}

function formatPreNotify(value: unknown): string {
  const minutes = numberOrNull(value);
  return minutes && minutes > 0 ? `事前通知: ${formatMinutes(minutes)}前` : "事前通知: なし";
}

function formatMinutes(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}時間`;
  return `${minutes}分`;
}

function parsePreNotifyMode(value: string): PreNotifyMode {
  const normalized = value.toLowerCase();
  if (normalized === "ask" || normalized.includes("毎回")) return "ask";
  if (normalized === "off" || normalized.includes("オフ") || normalized.includes("なし")) return "off";
  return "fixed";
}

function parsePreNotifyText(value: string): number | undefined {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[　\s]/g, "")
    .replace(/まえ/g, "前");
  if (!normalized) return undefined;
  if (/^(なし|無し|オフ|off|no|不要)$/.test(normalized)) return 0;
  const hour = normalized.match(/(\d{1,2})(?:時間|じかん|h|hour)/);
  const minute = normalized.match(/(\d{1,3})(?:分|ふん|ぷん|m|min|minute)/);
  const bare = normalized.match(/^(\d{1,3})$/);
  const total = (hour ? Number(hour[1]) * 60 : 0) + (minute ? Number(minute[1]) : 0) + (!hour && !minute && bare ? Number(bare[1]) : 0);
  if (!Number.isFinite(total) || total < 0 || total > 24 * 60) return undefined;
  return total;
}

function formatPreNotifyMode(mode: PreNotifyMode): string {
  if (mode === "ask") return "毎回聞く";
  if (mode === "off") return "オフ";
  return "固定";
}

function formatPendingPreNotify(payload: Record<string, string | number | null>): string {
  return payload.pre_notify_pending ? "事前通知: 未設定" : formatPreNotify(payload.pre_notify_minutes);
}

function expensePendingAside(payload: Record<string, string | number | null>): string {
  const saved = stringOrNull(payload.ai_comment);
  if (saved) return saved;
  const base = stringOrNull(payload.confirmation_base_content);
  const marker = "支出候補を検出しました。";
  if (base?.includes(marker)) return base.slice(0, base.indexOf(marker)).trim();
  return "";
}

function formatExpensePendingContent(payload: Record<string, string | number | null>): string {
  const spentAt = stringOrNull(payload.spent_at);
  return fitDiscordContent([
    expensePendingAside(payload),
    "支出候補を検出しました。",
    formatExpenseCandidate(
      Math.max(0, Math.round(Number(payload.amount ?? 0))),
      stringOrNull(payload.category),
      String(payload.memo ?? payload.item ?? payload.content ?? ""),
      stringOrNull(payload.store),
      spentAt
    )
  ].filter(Boolean), 1900);
}

function pendingContent(kind: string, payload: Record<string, string | number | null>): string {
  const baseContent = typeof payload.confirmation_base_content === "string" ? payload.confirmation_base_content : "";
  if (kind === "expense") return formatExpensePendingContent(payload);
  if ((kind === "todo" || kind === "reminder") && baseContent) {
    return `${baseContent}\n${formatPendingPreNotify(payload)}`;
  }
  if (baseContent) return baseContent;
  if (kind === "todo") {
    return `この内容でtodoに登録しますか？\n${formatTodoCandidate(String(payload.content ?? ""), stringOrNull(payload.due_at))}\n${formatPendingPreNotify(payload)}`;
  }
  if (kind === "reminder") {
    return `この内容でリマインダーに登録しますか？\n${formatReminderCandidate(String(payload.content ?? ""), stringOrNull(payload.remind_at), stringOrNull(payload.recurrence_label))}\n${formatPendingPreNotify(payload)}`;
  }
  return "この内容で登録しますか？";
}

function expenseRecordedContent(payload: Record<string, string | number | null>): string {
  return [
    pendingContent("expense", payload),
    "",
    "支出を記録しました。"
  ].join("\n");
}

function expenseCancelledContent(payload: Record<string, string | number | null>): string {
  return [
    pendingContent("expense", payload),
    "",
    "支出記録を取り消しました。"
  ].join("\n");
}

function appendInteractionMessage(interaction: DiscordInteraction, addition: string): string {
  const content = interaction.message?.content?.trim();
  return content ? `${content}\n\n${addition}` : addition;
}

function expiredPendingContent(kind: string, payload: Record<string, string | number | null>): string {
  return [
    YUUKA_PHRASES.expiredConfirmation,
    "",
    "期限切れになった内容:",
    pendingSummary(kind, payload)
  ].join("\n");
}

function pendingSummary(kind: string, payload: Record<string, string | number | null>): string {
  if (kind === "expense") {
    return [
      "支出候補を検出しました。",
      formatExpenseCandidate(
        Math.max(0, Math.round(Number(payload.amount ?? 0))),
        stringOrNull(payload.category),
        String(payload.memo ?? payload.item ?? payload.content ?? ""),
        stringOrNull(payload.store),
        stringOrNull(payload.spent_at)
      )
    ].join("\n");
  }
  if (kind === "done") {
    return `todo完了候補: #${payload.todo_id ?? "?"}`;
  }
  if (kind === "reminder_delete") {
    return `リマインダー削除候補: #${payload.reminder_id ?? "?"}`;
  }
  return pendingContent(kind, payload);
}

function rebuildTodoConfirmationBase(payload: Record<string, string | number | null>, dueAt: string): string {
  const baseContent = typeof payload.confirmation_base_content === "string" ? payload.confirmation_base_content : "";
  const prefix = stripCandidateDetails(baseContent) || "todo候補を検出しました。";
  return [
    prefix,
    formatTodoCandidate(String(payload.content ?? ""), dueAt)
  ].join("\n");
}

function rebuildReminderConfirmationBase(payload: Record<string, string | number | null>, remindAt: string): string {
  const baseContent = typeof payload.confirmation_base_content === "string" ? payload.confirmation_base_content : "";
  const prefix = stripCandidateDetails(baseContent) || "リマインダー候補を検出しました。";
  return [
    prefix,
    formatReminderCandidate(String(payload.content ?? ""), remindAt, stringOrNull(payload.recurrence_label))
  ].join("\n");
}

function stripCandidateDetails(content: string): string {
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^(内容|期限|日時|繰り返し|事前通知):/.test(trimmed)) return false;
      if (trimmed.includes("期限の変数が未定です")) return false;
      if (trimmed.includes("期限なしでtodoにしますか")) return false;
      if (trimmed.includes("日時の変数が未定です")) return false;
      if (trimmed.includes("いつ通知するか設定してください")) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function registeredContent(kind: "todo" | "reminder", id: number | undefined, payload: Record<string, string | number | null>): string {
  if (kind === "todo") {
    return [
      `先生、todo #${id ?? "?"} を登録しました。`,
      formatTodoCandidate(String(payload.content ?? ""), stringOrNull(payload.due_at)),
      formatPreNotify(payload.pre_notify_minutes ?? null)
    ].join("\n");
  }
  return [
    `先生、リマインダー #${id ?? "?"} を登録しました。`,
    formatReminderCandidate(String(payload.content ?? ""), String(payload.remind_at ?? ""), stringOrNull(payload.recurrence_label)),
    formatPreNotify(payload.pre_notify_minutes ?? null)
  ].join("\n");
}

function reminderRegisteredComment(content: string): string {
  if (/ご飯|昼|食べ|飲|水|薬|休憩|寝|起き/.test(content)) {
    return "先生、体調管理も大事な変数です。時間になったら通知します。";
  }
  if (/行く|出る|駅|移動|集合|予約|会議|電話/.test(content)) {
    return "先生、予定時刻に遅れないよう通知します。準備時間も計算に入れてくださいね。";
  }
  return "先生、予定時刻に通知しますね。";
}

function pendingComponentOptions(kind: string, payload: Record<string, string | number | null>): { dueButton: boolean; remindButton: boolean; preNotifyButton: boolean } {
  const todoHasDue = kind === "todo" && Boolean(payload.due_at);
  const reminderHasTime = kind === "reminder" && Boolean(payload.remind_at);
  return {
    dueButton: kind === "todo" && !todoHasDue,
    remindButton: kind === "reminder" && !reminderHasTime,
    preNotifyButton: Boolean(payload.pre_notify_pending) && (todoHasDue || reminderHasTime)
  };
}

function pendingComponents(id: string, options: { dueButton?: boolean; remindButton?: boolean; preNotifyButton?: boolean } = {}): unknown[] {
  if (options.preNotifyButton) {
    return [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "事前通知を設定", custom_id: `pretime:${id}` },
          { type: 2, style: 2, label: "事前通知を設定しない", custom_id: `pre:${id}:0` }
        ]
      },
      {
        type: 1,
        components: [
          { type: 2, style: 4, label: "取り消し", custom_id: `confirm:${id}:cancel` }
        ]
      }
    ];
  }

  if (options.remindButton) {
    return [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: "日時を設定", custom_id: `remind:${id}` }
        ]
      },
      {
        type: 1,
        components: [
          { type: 2, style: 4, label: "取り消し", custom_id: `confirm:${id}:cancel` }
        ]
      }
    ];
  }

  const rows: unknown[] = [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "確定", custom_id: `confirm:${id}:ok` },
      { type: 2, style: 4, label: "取り消し", custom_id: `confirm:${id}:cancel` }
    ]
  }];

  if (options.dueButton) {
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 2, label: "期限を設定", custom_id: `due:${id}` }
      ]
    });
  }
  return rows;
}

function pendingExpenseComponents(id: string, payload: Record<string, string | number | null>): unknown[] {
  const current = normalizeExpenseCategory(payload.category, EXPENSE_CATEGORIES);
  return [
    {
      type: 1,
      components: [{
        type: 3,
        custom_id: `expense_cat:${id}`,
        placeholder: `大分類: ${current}`,
        min_values: 1,
        max_values: 1,
        options: EXPENSE_CATEGORIES.map((category) => ({
          label: category,
          value: category,
          default: category === current
        }))
      }]
    },
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "記録する", custom_id: `expense:${id}:ok` },
        { type: 2, style: 4, label: "記録しない", custom_id: `expense:${id}:cancel` }
      ]
    }
  ];
}

function reminderDueComponents(id: number): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "対応済み", custom_id: `reminder_done:${id}` }
      ]
    },
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "5分後", custom_id: `snooze:${id}:5` },
        { type: 2, style: 2, label: "30分後", custom_id: `snooze:${id}:30` },
        { type: 2, style: 2, label: "1時間後", custom_id: `snooze:${id}:60` },
        { type: 2, style: 2, label: "3時間後", custom_id: `snooze:${id}:180` },
        { type: 2, style: 2, label: "明日", custom_id: `snooze:${id}:tomorrow` }
      ]
    }
  ];
}

function recurringReminderDueComponents(id: number): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "対応済み", custom_id: `recurring_done:${id}` },
        { type: 2, style: 4, label: "繰り返しを削除", custom_id: `reminder_delete:${id}` }
      ]
    },
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "5分後", custom_id: `recurring_snooze:${id}:5` },
        { type: 2, style: 2, label: "30分後", custom_id: `recurring_snooze:${id}:30` },
        { type: 2, style: 2, label: "1時間後", custom_id: `recurring_snooze:${id}:60` },
        { type: 2, style: 2, label: "3時間後", custom_id: `recurring_snooze:${id}:180` },
        { type: 2, style: 2, label: "明日", custom_id: `recurring_snooze:${id}:tomorrow` }
      ]
    }
  ];
}

function todoDueComponents(id: number): unknown[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "完了", custom_id: `done:${id}` },
      { type: 2, style: 2, label: "まだ終わってない", custom_id: `todo_wait:${id}` }
    ]
  }];
}

function todoSnoozeComponents(id: number): unknown[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 2, label: "5分後", custom_id: `todo_snooze:${id}:5` },
      { type: 2, style: 2, label: "30分後", custom_id: `todo_snooze:${id}:30` },
      { type: 2, style: 2, label: "1時間後", custom_id: `todo_snooze:${id}:60` }
    ]
  }];
}

function snoozeDate(action: string, env: Env): string | null {
  if (action === "tomorrow") {
    const parts = zonedParts(new Date(), env.TIMEZONE ?? "Asia/Tokyo");
    return `${dateOffsetKey(parts, 1)}T09:00:00+09:00`;
  }
  const minutes = Number(action);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function todayLoadWarning(total: number): string {
  if (total < 6) return "";
  return YUUKA_PHRASES.todayLoadWarning(total);
}

function isLastDayOfMonth(parts: { year: number; month: number; day: number }): boolean {
  const tomorrow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return tomorrow.getUTCDate() === 1;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeRecurrenceRule(value: unknown, datetime: string | null, timezone: string): RecurrenceRule | null {
  const rule = typeof value === "string" ? parseRecurrenceRule(value) : value as Partial<RecurrenceRule> | null;
  if (!rule || (rule.type !== "daily" && rule.type !== "weekly" && rule.type !== "monthly")) return null;
  const normalized: RecurrenceRule = {
    type: rule.type,
    interval: Math.max(1, Math.min(12, Number(rule.interval ?? 1) || 1)),
    timezone: rule.timezone || timezone
  };
  if (rule.type === "weekly") {
    const weekdays = Array.isArray(rule.weekdays) ? rule.weekdays.map(Number).filter((day) => day >= 1 && day <= 7) : [];
    if (!weekdays.length) return null;
    normalized.weekdays = [...new Set(weekdays)].sort((a, b) => a - b);
  }
  if (rule.type === "monthly") {
    const days = Array.isArray(rule.month_days) ? rule.month_days.map(Number).filter((day) => day >= 1 && day <= 31) : [];
    if (!days.length) return null;
    normalized.month_days = [...new Set(days)].sort((a, b) => a - b);
  }
  const fromDatetime = datetime?.match(/T(\d{2}:\d{2})/)?.[1];
  const time = typeof rule.time === "string" && /^\d{1,2}:\d{2}$/.test(rule.time) ? normalizeClock(rule.time) : fromDatetime;
  if (time) normalized.time = time;
  return normalized;
}

function parseRecurrenceRule(value: unknown): RecurrenceRule | null {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return normalizeRecurrenceRule(parsed, null, "Asia/Tokyo");
  } catch {
    return null;
  }
}

function serializeRecurrenceRule(rule: RecurrenceRule | null): string | null {
  return rule ? JSON.stringify(rule) : null;
}

function recurrenceLabel(rule: RecurrenceRule | null): string | null {
  if (!rule) return null;
  if (rule.type === "daily") return "毎日";
  if (rule.type === "weekly") {
    const weekdays = rule.weekdays?.map((day) => ["", "月曜", "火曜", "水曜", "木曜", "金曜", "土曜", "日曜"][day]).filter(Boolean);
    return weekdays?.length ? `毎週${weekdays.join("・")}` : "毎週";
  }
  if (rule.type === "monthly") {
    const days = rule.month_days?.map((day) => `${day}日`);
    return days?.length ? `毎月${days.join("・")}` : "毎月";
  }
  return null;
}

function nextRecurringAt(rule: RecurrenceRule, afterIso: string, env: Env): string | null {
  const timezone = rule.timezone ?? env.TIMEZONE ?? "Asia/Tokyo";
  const after = new Date(afterIso);
  const parts = zonedParts(new Date(after.getTime() + 60 * 1000), timezone);
  const time = rule.time ?? afterIso.match(/T(\d{2}:\d{2})/)?.[1] ?? "09:00";
  const [hour, minute] = time.split(":").map(Number);
  const start = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  for (let offset = 0; offset <= 370; offset += 1) {
    const candidateDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + offset));
    const candidateParts = {
      year: candidateDate.getUTCFullYear(),
      month: candidateDate.getUTCMonth() + 1,
      day: candidateDate.getUTCDate()
    };
    if (!recurrenceMatchesDate(rule, candidateParts)) continue;
    const candidate = toTokyoIso(candidateParts.year, candidateParts.month, candidateParts.day, hour, minute);
    if (new Date(candidate).getTime() > after.getTime()) return candidate;
  }
  return null;
}

function recurrenceMatchesDate(rule: RecurrenceRule, parts: { year: number; month: number; day: number }): boolean {
  if (rule.type === "daily") return true;
  if (rule.type === "weekly") {
    const weekday = dayOfWeek(parts) || 7;
    return Boolean(rule.weekdays?.includes(weekday));
  }
  if (rule.type === "monthly") {
    const last = lastDayOfMonth(parts.year, parts.month);
    return Boolean(rule.month_days?.some((day) => Math.min(day, last) === parts.day));
  }
  return false;
}

function toTokyoIso(year: number, month: number, day: number, hour: number, minute: number): string {
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+09:00`;
}

function firstOption(interaction: DiscordInteraction): DiscordOption | undefined {
  return interaction.data?.options?.[0];
}

function modalValue(interaction: DiscordInteraction, customId: string): string {
  for (const row of interaction.data?.components ?? []) {
    for (const component of row.components ?? []) {
      if (component.custom_id === customId && typeof component.value === "string") {
        return component.value;
      }
    }
  }
  return "";
}

function getString(option: DiscordOption, name: string): string | undefined {
  const found = option.options?.find((item) => item.name === name);
  return typeof found?.value === "string" ? found.value : undefined;
}

function getNumber(option: DiscordOption, name: string): number | undefined {
  const found = option.options?.find((item) => item.name === name);
  return typeof found?.value === "number" ? found.value : undefined;
}

function interactionUser(interaction: DiscordInteraction): DiscordUser {
  return interaction.member?.user ?? interaction.user ?? { id: "unknown" };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function reply(content: string, ephemeral: boolean): Response {
  return json({
    type: RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: ephemeral ? EPHEMERAL : undefined
    }
  });
}

function deferReply(ephemeral: boolean): Response {
  return json({
    type: RESPONSE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: ephemeral ? EPHEMERAL : undefined
    }
  });
}

function updateMessage(content: string): Response {
  return json({
    type: RESPONSE.UPDATE_MESSAGE,
    data: {
      content,
      components: []
    }
  });
}

function updateMessageWithComponents(content: string, components: unknown[]): Response {
  return json({
    type: RESPONSE.UPDATE_MESSAGE,
    data: {
      content,
      components
    }
  });
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function dayOfWeek(parts: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(value: string | null, env: Env): string {
  if (!value) return "未設定";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: env.TIMEZONE ?? "Asia/Tokyo",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function compareSnowflakes(a: string, b: string): number {
  const aa = BigInt(a);
  const bb = BigInt(b);
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function normalizeClock(value: string): string {
  const [hour, minute] = value.split(":").map((part) => Number(part));
  return `${pad(hour)}:${pad(minute)}`;
}

function isAtOrAfterClock(parts: { hour: number; minute: number }, target: string): boolean {
  const [hour, minute] = normalizeClock(target).split(":").map(Number);
  return parts.hour * 60 + parts.minute >= hour * 60 + minute;
}

function normalizeSettingText(value: string): string {
  return value
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[：＝]/g, (char) => char === "：" ? ":" : "=")
    .replace(/\u3000/g, " ");
}

function looksLikeCompletion(text: string): boolean {
  return /(終わった|完了|済んだ|やった|片付いた|できた)/.test(text);
}

function shouldChatReply(text: string): boolean {
  return /(疲れた|しんどい|やる気|無理|詰んだ|困った|どうしよう|助けて|ユウカ|ゆうか|先生)/.test(text);
}

function dateOffsetKey(parts: { year: number; month: number; day: number }, offsetDays: number): string {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offsetDays));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
