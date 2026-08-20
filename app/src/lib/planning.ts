/**
 * Planning: FN-WK-02「今やる一つ」決定論エンジン(依存関係・PEM補正なし版)。
 * 出典: ISMAY_機能別詳細設計書_v1.1 8章(FN-WK-02)、
 *       ISMAY_API_イベント設計書_v1.1 4.4節(API-PLAN-01 GET /planning/now)。
 *
 * [今回の実装スコープに関する設計判断(2026-08-20、決定論版として合意済みの範囲)]
 * FN-WK-02の優先要因のうち、以下は本エンジンでは未対応。理由を明記する。
 * - 「期限危険のブロック解消」: FN-GR-02(責任間関係・ブロック検知)が未実装のため対象外。
 * - 「最低ライン」: FN-WK-03(BaselineService)が未実装のため対象外。
 * - 「切替コスト」: 直前の実行コンテキストを保持する仕組みが未設計のため対象外。
 * - 「場所・権限不適合での除外」: Constraint(TBL-011)はレコードとして保存されるのみで、
 *   現在地・保有ツール等の実行時コンテキストと突合する仕組み(FR-PLAN-03)が未実装のため対象外。
 * - 「本人がスヌーズ」: responsibilitiesテーブルにスヌーズを保持する列が存在しないため対象外。
 * - 除外要因のうち設計書の「未開始」は、字義通りだと候補の大半が該当し趣旨と矛盾するため、
 *   FR-WK-04の「開始可能日」(startAfterAt)が未到来＝まだ開始できない、の除外と解釈した。
 * これらは calcVersion 付きの assumptions としてAPIレスポンスにそのまま含め、
 * UI側でも「今回考慮していない要因」として案内する(FR-WK-05「除外理由の概要を確認できる」に対応)。
 *
 * 対応済みの優先要因: Hard deadline接近度、WAITINGの追跡期限接近度、重要度。
 */

export interface PlanningCandidateInput {
  id: string;
  type: string;
  title: string;
  status: string;
  importance: number | null;
  hardDeadlineAt: Date | null;
  targetAt: Date | null;
  startAfterAt: Date | null;
  waitingFollowUpAt?: Date | null;
}

export interface ScoredCandidate {
  id: string;
  type: string;
  title: string;
  status: string;
  score: number;
  reasonCodes: string[];
}

/** 候補として扱う型・状態(actionable)。DECISION/RISK/CONCERN/IDEAはFR-WK-07により別枠表示のため対象外。 */
const CANDIDATE_STATUS_BY_TYPE: Record<string, readonly string[]> = {
  TASK: ["PLANNED", "IN_PROGRESS"],
  EVENT: ["PLANNED", "IN_PROGRESS"],
  HABIT: ["PLANNED", "IN_PROGRESS"],
  COMMITMENT: ["ACTIVE", "AT_RISK"],
  WAITING: ["FOLLOW_UP_DUE"],
};

export const PLANNING_CALC_VERSION = "planning-now-deterministic-v1";

export const PLANNING_ASSUMPTIONS = [
  "ASSUMPTION_NO_DEPENDENCY_GRAPH",
  "ASSUMPTION_NO_MINIMUM_LINE",
  "ASSUMPTION_NO_SWITCHING_COST",
  "ASSUMPTION_NO_CONTEXT_MATCH",
  "ASSUMPTION_NO_SNOOZE",
  "ASSUMPTION_STARTAFTER_AS_NOT_STARTABLE",
] as const;

function hoursFrom(nowMs: number, target: Date): number {
  return (target.getTime() - nowMs) / (1000 * 60 * 60);
}

/**
 * 1件をスコアリングする。スコア自体は内部順位付けにのみ使い、UIには表示しない
 * (機能別詳細設計書v1.1 8章「スコアそのものより理由を表示」)。
 */
export function scoreCandidate(c: PlanningCandidateInput, now: Date = new Date()): ScoredCandidate {
  const nowMs = now.getTime();
  let score = 0;
  const reasonCodes: string[] = [];

  if (c.hardDeadlineAt) {
    const h = hoursFrom(nowMs, c.hardDeadlineAt);
    if (h < 0) {
      score += 1000 + Math.min(-h, 200);
      reasonCodes.push("HARD_DEADLINE_OVERDUE");
    } else if (h <= 24) {
      score += 600 + (24 - h) * 5;
      reasonCodes.push("HARD_DEADLINE_WITHIN_24H");
    } else if (h <= 72) {
      score += 300 + (72 - h);
      reasonCodes.push("HARD_DEADLINE_WITHIN_72H");
    } else {
      score += Math.max(0, 100 - h / 24);
      reasonCodes.push("HARD_DEADLINE_UPCOMING");
    }
  }

  if (c.type === "WAITING" && c.waitingFollowUpAt) {
    const h = hoursFrom(nowMs, c.waitingFollowUpAt);
    if (h <= 0) {
      score += 500;
      reasonCodes.push("FOLLOW_UP_DUE_NOW");
    } else if (h <= 24) {
      score += 250 + (24 - h) * 2;
      reasonCodes.push("FOLLOW_UP_DUE_SOON");
    }
  }

  if (!c.hardDeadlineAt && c.targetAt) {
    const h = hoursFrom(nowMs, c.targetAt);
    if (h <= 24) {
      score += 80;
      reasonCodes.push("TARGET_AT_TODAY");
    } else if (h <= 72) {
      score += 30;
      reasonCodes.push("TARGET_AT_SOON");
    }
  }

  const importance = c.importance ?? 3;
  score += importance * 15;
  if (importance >= 4) {
    reasonCodes.push("HIGH_IMPORTANCE");
  }

  if (reasonCodes.length === 0) {
    reasonCodes.push("NO_STRONG_SIGNAL");
  }

  return { id: c.id, type: c.type, title: c.title, status: c.status, score, reasonCodes };
}

/** 除外要因を判定する。除外時も理由を返し、将来UIの「除外理由」表示に転用できるようにする。 */
export function isEligibleCandidate(
  c: PlanningCandidateInput,
  now: Date = new Date(),
): { eligible: boolean; excludeReason?: string } {
  const allowedStatuses = CANDIDATE_STATUS_BY_TYPE[c.type];
  if (!allowedStatuses || !allowedStatuses.includes(c.status)) {
    return { eligible: false, excludeReason: "STATUS_NOT_ACTIONABLE" };
  }
  if (c.startAfterAt && c.startAfterAt.getTime() > now.getTime()) {
    return { eligible: false, excludeReason: "NOT_YET_STARTABLE" };
  }
  return { eligible: true };
}

export interface PlanningNowResult {
  primary: ScoredCandidate | null;
  alternatives: ScoredCandidate[];
}

/** 候補群から「今やる一つ」＋代替最大3件を選ぶ(FN-WK-02: 上位5件をスコア化し1件＋代替3件)。 */
export function computeNow(candidates: PlanningCandidateInput[], now: Date = new Date()): PlanningNowResult {
  const eligible = candidates.filter((c) => isEligibleCandidate(c, now).eligible);
  const scored = eligible.map((c) => scoreCandidate(c, now)).sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);
  return {
    primary: top[0] ?? null,
    alternatives: top.slice(1, 4),
  };
}
