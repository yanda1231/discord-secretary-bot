import { fitDiscordContent } from "./expense-logic.ts";

export type RequestCueKind = "cancel" | "new" | "none";

export type RequestCueSpan = {
  start: number;
  end: number;
};

export type RequestCue = {
  kind: RequestCueKind;
  summary: string;
  cueSpan: RequestCueSpan | null;
};

export type RequestQuestionKind = "scene" | "pain" | "outcome";

export type IntakeCoverageFlags = {
  scene: boolean;
  pain: boolean;
  outcome: boolean;
};

export type RequestAnswerCandidate = {
  id: number;
  requestedBy: string;
  channelId: string;
  intakeMessageId?: string | null;
  intakeAt?: string | null;
  pendingQuestions: string;
};

export type RequestAnswerTargetInput = {
  isReply: boolean;
  replyMessageId?: string | null;
  referencedMessageIsBotIntakePost: boolean;
  candidates: readonly RequestAnswerCandidate[];
  actorId: string;
  channelId: string;
  now: string | number | Date;
};

export type RequestAnswerTargetDecision =
  | { kind: "reply_match"; request: RequestAnswerCandidate }
  | { kind: "direct_match"; request: RequestAnswerCandidate }
  | { kind: "reply_missing" }
  | { kind: "direct_ambiguous" }
  | { kind: "none" };

export type FeatureRequestListRow = {
  id: number;
  status: string;
  summary: string;
};

export const INTAKE_QUESTION_TEXT: Record<RequestQuestionKind, string> = {
  scene: "どの場面・どのチャンネルで使いたいですか？",
  pain: "今はどこが不便ですか？",
  outcome: "どうなっていたら『できた』と言えますか？"
};

export const REQUEST_DETAILS_UPDATE_SQL = `UPDATE feature_requests
SET details = CASE WHEN details = '' THEN ? ELSE details || char(10) || ? END,
    pending_questions = '',
    updated_at = CURRENT_TIMESTAMP
WHERE id = ? AND requested_by = ? AND channel_id = ? AND status = 'open'`;

const REQUEST_CANCEL_PATTERN = /^(さっきの|直前の|今の)?要望(は|を)?(なし|無し|取り消し|取消|やめ|キャンセル)(です|で|ます|。|！|!)*$/u;
const REQUEST_HEAD_PATTERN = /^(機能要望|アップデート要望|要望)(です|だけど|なんだけど)?[\s:：、。，]+/u;
const REQUEST_NEGATION_PATTERN = /要望(は|が)?(ない|無い|なし)|要望しない/u;
const REQUEST_POSITIVE_PATTERN = /欲しい|ほしい|できるように|してほしい|して欲しい|追加して|便利/u;
const REQUEST_QUESTION_ORDER: RequestQuestionKind[] = ["scene", "pain", "outcome"];
const REQUEST_STATUS_LABELS: Record<string, string> = {
  open: "受付",
  in_progress: "対応中",
  done: "対応済み",
  declined: "見送り"
};

function trimDisplay(value: string, max: number): string {
  const characters = [...value];
  return characters.length > max
    ? `${characters.slice(0, Math.max(0, max - 1)).join("")}…`
    : value;
}

/** Resolve cancellation and explicit/implicit new-request cues in fixed order. */
export function resolveRequestCue(text: string): RequestCue {
  const source = text.trim();
  if (REQUEST_CANCEL_PATTERN.test(source)) {
    return { kind: "cancel", summary: "", cueSpan: null };
  }

  const head = source.match(REQUEST_HEAD_PATTERN);
  if (head) {
    const end = head[0].length;
    return {
      kind: "new",
      summary: source.slice(end).trim(),
      cueSpan: { start: 0, end }
    };
  }

  const normalized = source.normalize("NFKC");
  if (normalized.includes("要望") && REQUEST_POSITIVE_PATTERN.test(normalized) && !REQUEST_NEGATION_PATTERN.test(normalized)) {
    return { kind: "new", summary: source, cueSpan: null };
  }
  return { kind: "none", summary: "", cueSpan: null };
}

/** Select at most two fixed questions; invalid AI flags deliberately yield no questions. */
export function selectIntakeQuestions(flags: IntakeCoverageFlags | null | undefined): RequestQuestionKind[] {
  if (!flags || REQUEST_QUESTION_ORDER.some((kind) => typeof flags[kind] !== "boolean")) return [];
  return REQUEST_QUESTION_ORDER.filter((kind) => !flags[kind]).slice(0, 2);
}

function timestampMs(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

function isRecentIntake(candidate: RequestAnswerCandidate, now: string | number | Date): boolean {
  if (!candidate.pendingQuestions.trim() || !candidate.intakeAt) return false;
  const intakeAt = timestampMs(candidate.intakeAt);
  const nowAt = timestampMs(now);
  if (!Number.isFinite(intakeAt) || !Number.isFinite(nowAt)) return false;
  const age = nowAt - intakeAt;
  return age >= 0 && age <= 30 * 60 * 1000;
}

/** Resolve reply and one-shot non-reply answer targets without looking at message prose. */
export function resolveRequestAnswerTarget(input: RequestAnswerTargetInput): RequestAnswerTargetDecision {
  if (input.isReply) {
    const referenceId = input.replyMessageId?.trim();
    const referenced = referenceId
      ? input.candidates.find((candidate) => candidate.intakeMessageId === referenceId)
      : undefined;
    if (referenced) return { kind: "reply_match", request: referenced };
    return input.referencedMessageIsBotIntakePost ? { kind: "reply_missing" } : { kind: "none" };
  }

  const active = input.candidates.filter((candidate) =>
    candidate.requestedBy === input.actorId
    && candidate.channelId === input.channelId
    && isRecentIntake(candidate, input.now)
  );
  if (active.length > 1) return { kind: "direct_ambiguous" };
  if (active.length === 1) return { kind: "direct_match", request: active[0] };
  return { kind: "none" };
}

export function renderIntakeMessage(summary: string, questionKinds: readonly RequestQuestionKind[]): string {
  const displaySummary = trimDisplay(summary.replace(/\s+/gu, " ").trim(), 400);
  const questions = questionKinds.filter((kind, index, all) =>
    Object.prototype.hasOwnProperty.call(INTAKE_QUESTION_TEXT, kind)
    && all.indexOf(kind) === index
  ).slice(0, 2);
  const lines = [
    "要望として受け付けました。",
    `「${displaySummary}」`
  ];
  if (!questions.length) {
    lines.push("詳細が必要になったら聞きますね");
  } else {
    lines.push(...questions.map((kind) => INTAKE_QUESTION_TEXT[kind]));
    lines.push("（答えはこのメッセージにリプライで。任意です）");
  }
  return fitDiscordContent(lines, 1900);
}

export function formatRequestList(rows: readonly FeatureRequestListRow[]): string {
  if (!rows.length) return "機能要望: なし";
  const lines = [
    "機能要望一覧",
    ...rows.slice(0, 20).map((row) => {
      const summary = trimDisplay(row.summary.replace(/\s+/gu, " ").trim(), 60);
      return `#${row.id} [${REQUEST_STATUS_LABELS[row.status] ?? row.status}] ${summary}`;
    })
  ];
  return fitDiscordContent(lines, 1900);
}
