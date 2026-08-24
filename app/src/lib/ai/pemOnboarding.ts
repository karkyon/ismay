import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { getActivePemDialogueProvider } from "@/lib/ai/config";
import { estimateCostMicros } from "@/lib/ai/pricing";
import { PemOnboardingTurnResultSchema, CONVERSATION_STATE_ORDER, type ConversationState } from "@/lib/ai/pemSchema";
import { checkPemSafety, PEM_SAFETY_FALLBACK_MESSAGE } from "@/lib/ai/pemSafety";
import type { PemDialogueProvider, PemOnboardingUsage } from "@/lib/ai/pemProvider";

/**
 * FN-PEM-01 初回対話(機能別詳細設計書v1.1 12章)のオーケストレーション。
 * lib/ai/extract.ts(FN-AI-01)と同じ方針: AI Gateway呼び出し→zod検証→SafetyValidator→
 * 永続化を1関数に閉じる。呼び出し元(APIルート)はconversationId(=userId)とメッセージのみ渡す。
 *
 * [設計判断・2026-08-23] API・イベント設計書v1.1 4.5節は「最大2回」のAI Gateway再試行を
 * 明記していないが(FN-AI-01固有の記述)、FN-PEM-01もAI Gatewayの一部であるため、
 * 2章「Retryは一時障害と修復可能な構造違反に限定。最大2回」に従い同じ再試行方針を適用する。
 *
 * [2026-08-24改訂・Phase 0E] PemOnboardingConversation.userIdのunique制約を廃止し
 * (v4.0 11章、複数履歴を許可)、findOrCreateCurrentConversation()が「そのユーザーの
 * 最新の対話行」を都度探索する方式へ変更した。既存データ(1ユーザー1行)に対しては
 * 従来と同じ挙動になる(常に最新=唯一の行を返すため)。
 */

const MAX_AI_ATTEMPTS = 2;

/**
 * ユーザーの現在の対話を返す(最新の行。無ければconversationKind="INITIAL"で新規作成)。
 * RECALIBRATION/MAJOR_CHANGEの生成トリガーは本パッチのスコープ外(v4.0 11章の該当詳細
 * 未確認のため未実装)。新規作成時は常にINITIALとする。
 */
async function findOrCreateCurrentConversation(userId: string) {
  const existing = await db.pemOnboardingConversation.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;
  return db.pemOnboardingConversation.create({
    data: { userId, conversationKind: "INITIAL" },
  });
}
const DEFAULT_TIMEZONE = "Asia/Tokyo"; // TBD-10と同じ前提(extract.tsと合わせる)
const MAX_HISTORY_MESSAGES = 20; // プロンプト肥大化防止。直近20件のみモデルへ渡す

export type PemOnboardingMessageResult =
  | {
      status: "OK";
      assistantMessage: string;
      proposedFacts: { kind: "FACT" | "SELF_REPORT"; statement: string }[];
      proposedHypotheses: { statement: string; confidence: number }[];
      nextQuestion: string | null;
      completion: boolean;
      state: ConversationState;
    }
  | { status: "FAILED"; reason: string };

interface StoredMessage {
  role: "assistant" | "user";
  content: string;
  at: string;
}

/** REVIEW到達後、ユーザーの返信を「確認」とみなす簡易判定(否定語が無ければ確認とみなす)。 */
function looksLikeConfirmation(message: string): boolean {
  const negationPatterns = [/違う/, /修正/, /やり直/, /間違/, /訂正/];
  return !negationPatterns.some((p) => p.test(message));
}

async function persistTurn(params: {
  userId: string;
  workspaceId: string;
  ai: PemDialogueProvider;
  status: "SUCCEEDED" | "FAILED";
  usage: PemOnboardingUsage | undefined;
  errorReason?: string;
}): Promise<void> {
  const { userId, workspaceId, ai, status, usage, errorReason } = params;
  await db.aiRun.create({
    data: {
      workspaceId,
      provider: ai.providerName,
      model: ai.modelName,
      promptVersion: ai.promptVersion,
      schemaVersion: ai.schemaVersion,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      costMicros: usage ? estimateCostMicros(ai.modelName, usage.inputTokens, usage.outputTokens) : null,
      latencyMs: usage?.latencyMs,
      status,
      errorCode: errorReason?.slice(0, 200),
      finishedAt: new Date(),
    },
  });
  debugServer.event("pemOnboarding/persistTurn", "AiRun記録", { userId, status });
}

export async function processOnboardingMessage(
  userId: string,
  workspaceId: string,
  message: string,
  skip: boolean,
): Promise<PemOnboardingMessageResult> {
  const conversation = await findOrCreateCurrentConversation(userId);

  if (conversation.completedAt) {
    return {
      status: "OK",
      assistantMessage: "初回対話は既に完了しています。内容の確認・訂正は「あなたの実行モデル」画面から行えます。",
      proposedFacts: [],
      proposedHypotheses: [],
      nextQuestion: null,
      completion: true,
      state: "DONE",
    };
  }

  const state = conversation.state as ConversationState;
  const history = (conversation.messages as unknown as StoredMessage[]) ?? [];

  // REVIEW状態でのユーザー返信は「確認/訂正」であり、新たなAI Gateway呼び出しなしで
  // 完了させられる(AI-06の役割は事実・仮説候補の抽出までであり、確認自体は決定論処理でよい)。
  if (state === "REVIEW" && !skip) {
    if (looksLikeConfirmation(message)) {
      return finalizeOnboarding(userId, conversation.id, history, message);
    }
    // 訂正希望: REVIEWのまま、AIに再確認メッセージを作らせる(下の通常フローへ進む)。
  }

  const ai = await getActivePemDialogueProvider(workspaceId);
  debugServer.event("pemOnboarding/processOnboardingMessage", "PROVIDER_RESOLVED", {
    userId,
    providerName: ai.providerName,
    modelName: ai.modelName,
  });

  let lastFailureReason = "";
  let lastUsage: PemOnboardingUsage | undefined;

  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
    const outcome = await ai.runOnboardingTurn({
      state,
      history: history.slice(-MAX_HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content })),
      userMessage: message,
      skip,
      nowIso: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
    });

    if (!outcome.ok) {
      lastFailureReason = outcome.message;
      lastUsage = outcome.usage;
      if (outcome.kind === "FATAL") break;
      continue;
    }

    lastUsage = outcome.usage;
    const parsed = PemOnboardingTurnResultSchema.safeParse(outcome.rawJson);
    if (!parsed.success) {
      lastFailureReason = `AI_SCHEMA_INVALID: ${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 500)}`;
      continue;
    }

    // SafetyValidator(§13・EVAL-04): 人格断定・診断語・保護属性を検出したら
    // 非公開化しテンプレートへフォールバックする。
    const safety = checkPemSafety(parsed.data.assistantMessage);
    const safeAssistantMessage = safety.safe ? parsed.data.assistantMessage : PEM_SAFETY_FALLBACK_MESSAGE;
    if (!safety.safe) {
      debugServer.error("pemOnboarding/processOnboardingMessage", "SafetyValidator違反、テンプレートへフォールバック", {
        userId,
        violations: safety.violations,
      });
    }
    // proposedHypothesesも同様に文面をチェックし、違反があれば当該候補を除外する
    // (§9「1件で恒常仮説を作らない」・母数ガードとは別に、文面自体の安全性を担保する)。
    const safeHypotheses = parsed.data.proposedHypotheses.filter((h) => checkPemSafety(h.statement).safe);

    await persistTurn({ userId, workspaceId, ai, status: "SUCCEEDED", usage: outcome.usage });

    const newHistory: StoredMessage[] = [
      ...history,
      ...(skip ? [] : [{ role: "user" as const, content: message, at: new Date().toISOString() }]),
      { role: "assistant" as const, content: safeAssistantMessage, at: new Date().toISOString() },
    ];

    const currentIndex = CONVERSATION_STATE_ORDER.indexOf(state);
    const nextState: ConversationState =
      parsed.data.blockComplete && currentIndex < CONVERSATION_STATE_ORDER.length - 1
        ? CONVERSATION_STATE_ORDER[currentIndex + 1]
        : state;

    const mergedFacts = [
      ...((conversation.proposedFacts as unknown as { kind: string; statement: string }[]) ?? []),
      ...parsed.data.proposedFacts,
    ];
    const mergedHypotheses = [
      ...((conversation.proposedHypotheses as unknown as { statement: string; confidence: number }[]) ?? []),
      ...safeHypotheses,
    ];

    await db.pemOnboardingConversation.update({
      where: { id: conversation.id },
      data: {
        state: nextState,
        messages: newHistory as unknown as object,
        proposedFacts: mergedFacts as unknown as object,
        proposedHypotheses: mergedHypotheses as unknown as object,
      },
    });

    return {
      status: "OK",
      assistantMessage: safeAssistantMessage,
      proposedFacts: parsed.data.proposedFacts,
      proposedHypotheses: safeHypotheses,
      nextQuestion: nextState === "REVIEW" || nextState === "DONE" ? null : safeAssistantMessage,
      completion: nextState === "DONE",
      state: nextState,
    };
  }

  await persistTurn({ userId, workspaceId, ai, status: "FAILED", usage: lastUsage, errorReason: lastFailureReason });
  return { status: "FAILED", reason: lastFailureReason };
}

/**
 * REVIEW状態での確認完了処理。proposedFacts(FACT扱いのもののみ)をpem_observationsへ
 * 昇格させ、proposedHypothesesをpem_hypothesesへ保存し、対話をDONEにする。
 * SELF_REPORT扱いのproposedFactsは「未確認の自己申告」のためpem_observationsへは
 * 昇格させない(PEM設計書7章: FACTは「出所・確認者・更新日」を要件とし、本人確認が
 * 必須。SELF_REPORTは「本人発言・文脈・有効期間」のみでよく、確認完了時点では
 * まだ本人の直接確認を経ていないため、ここでは慎重側に倒しFACTのみ昇格する)。
 */
async function finalizeOnboarding(
  userId: string,
  conversationId: string,
  history: StoredMessage[],
  confirmationMessage: string,
): Promise<PemOnboardingMessageResult> {
  const conversation = await db.pemOnboardingConversation.findUniqueOrThrow({ where: { id: conversationId } });
  const facts = (conversation.proposedFacts as unknown as { kind: string; statement: string }[]) ?? [];
  const hypotheses = (conversation.proposedHypotheses as unknown as { statement: string; confidence: number }[]) ?? [];

  await db.$transaction(async (tx: any) => {
    for (const fact of facts) {
      if (fact.kind !== "FACT") continue;
      await tx.pemObservation.create({
        data: {
          userId,
          observationType: "FACT",
          payload: { statement: fact.statement, source: "ONBOARDING" } as unknown as object,
        },
      });
    }
    const now = new Date();
    for (const hyp of hypotheses) {
      // 母数ガード(§9「1件で恒常仮説を作らない」): 初回対話由来の仮説はsampleSize=1の
      // ため、confidenceを0.3以下に強制し「一時観察」相当として扱う(UI側での確度表示に
      // 反映させる想定。恒常仮説への昇格はFN-PEM-02の観察蓄積後に行う)。
      await tx.pemHypothesis.create({
        data: {
          userId,
          statement: hyp.statement,
          sampleSize: 1,
          windowFrom: now,
          windowTo: now,
          confidence: Math.min(hyp.confidence, 0.3),
          userVerdict: "UNREVIEWED",
        },
      });
    }
    await tx.pemOnboardingConversation.update({
      where: { id: conversationId },
      data: {
        state: "DONE",
        completedAt: now,
        messages: [
          ...history,
          { role: "user", content: confirmationMessage, at: now.toISOString() },
        ] as unknown as object,
      },
    });
  });

  debugServer.event("pemOnboarding/finalizeOnboarding", "初回対話完了", {
    userId,
    factCount: facts.filter((f) => f.kind === "FACT").length,
    hypothesisCount: hypotheses.length,
  });

  return {
    status: "OK",
    assistantMessage: `暫定モデルができました。事実${facts.filter((f) => f.kind === "FACT").length}件・仮説${hypotheses.length}件を記録しました。運用しながら精度を上げていきます。あとからいつでも訂正できます。`,
    proposedFacts: [],
    proposedHypotheses: [],
    nextQuestion: null,
    completion: true,
    state: "DONE",
  };
}
