/**
 * V5-M1-B5a Question Policy 不変条件テスト。
 * 既存 formation/__tests__/coreInvariants.test.ts と同じdb非依存パターン
 * (npx tsx で直接実行、DATABASE_URL不要)。
 */
import { ResponsibilityCandidateSchema, type ResponsibilityCandidate } from "../../ai/schema";
import {
  QUESTION_POLICY_VERSION,
  QUESTION_SCORE_THRESHOLDS,
  computeQuestionScore,
  buildQuestionCandidatesForCandidate,
  selectSessionQuestions,
  applyAnswerToCandidate,
  getAnswerKindForQuestionCode,
  getStaticQuestionOptions,
  type SessionCandidateInput,
} from "../questionPolicy";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` (${detail})` : ""}`);
    console.log(`  FAIL - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function baseCandidate(overrides: Partial<ResponsibilityCandidate> = {}): ResponsibilityCandidate {
  return {
    candidateId: "c1",
    type: "TASK",
    title: "報告書を提出する",
    evidenceSpans: [{ start: 0, end: 5 }],
    confidence: 0.9,
    dateMentions: [],
    unknowns: [],
    blockedByCandidateIds: [],
    suggestedTags: [],
    ...overrides,
  } as ResponsibilityCandidate;
}

console.log("=== questionPolicy.test.ts ===");

// --- (0) 基本: policy version ---
ok("QUESTION_POLICY_VERSIONがv1", QUESTION_POLICY_VERSION === "v1");

// --- (1) [最重要] 通常の個人TASK(fieldがいくつか空)は質問を生成しない ---
{
  const c = baseCandidate({ type: "TASK", completionCondition: "提出完了メールを受け取る" });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok(
    "actor欠落だけの個人TASKは質問0件(空欄=質問ではない)",
    qs.length === 0,
    `got ${qs.length}: ${qs.map((q) => q.questionCode).join(",")}`,
  );
}

// --- (2) COMMITMENTでcounterparty欠落 → P0質問生成 ---
{
  const c = baseCandidate({ type: "COMMITMENT", counterparty: undefined });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok("COMMITMENT+counterparty欠落でCOMMITMENT_COUNTERPARTY_MISSINGが生成される",
    qs.some((q) => q.questionCode === "COMMITMENT_COUNTERPARTY_MISSING" && q.priority === "P0"));
}
// counterparty・completionCondition両方あれば生成しない
{
  const c = baseCandidate({ type: "COMMITMENT", counterparty: "山田さん", completionCondition: "承認を得る" });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok("COMMITMENT+counterparty/completionCondition両方有りなら質問0件", qs.length === 0, `got ${qs.length}`);
}

// --- (3) WAITINGでcounterparty欠落 → P1質問 ---
{
  const c = baseCandidate({ type: "WAITING", counterparty: undefined, completionCondition: "返信が来る" });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok("WAITING+counterparty欠落でWAITING_COUNTERPARTY_MISSING(P1)が生成される",
    qs.some((q) => q.questionCode === "WAITING_COUNTERPARTY_MISSING" && q.priority === "P1"));
}

// --- (4) 完了条件欠落 → 対象型のみP1質問 ---
{
  const c = baseCandidate({ type: "TASK", completionCondition: undefined });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok("TASK+completionCondition欠落でCOMPLETION_CONDITION_MISSINGが生成される",
    qs.some((q) => q.questionCode === "COMPLETION_CONDITION_MISSING"));
}
{
  const c = baseCandidate({ type: "IDEA", completionCondition: undefined });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok("IDEA(対象外型)はcompletionCondition欠落でも質問しない",
    !qs.some((q) => q.questionCode === "COMPLETION_CONDITION_MISSING"));
}

// --- (5) HARD_DEADLINE低confidence → P0質問(選択式) ---
{
  const c = baseCandidate({
    completionCondition: "提出する",
    dateMentions: [{ rawExpression: "来週中", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", confidence: 0.3 }],
  });
  const qs = buildQuestionCandidatesForCandidate(c);
  const q = qs.find((x) => x.questionCode === "HARD_DEADLINE_LOW_CONFIDENCE");
  ok("HARD_DEADLINE低confidenceで質問生成", q !== undefined);
  ok("HARD_DEADLINE質問はSELECTED", q?.answerKind === "SELECTED");
  ok("HARD_DEADLINE質問はoptions2件", q?.options?.length === 2);
}
{
  const c = baseCandidate({
    completionCondition: "提出する",
    dateMentions: [{ rawExpression: "来週中", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", confidence: 0.95 }],
  });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok("HARD_DEADLINE高confidenceなら質問しない",
    !qs.some((x) => x.questionCode === "HARD_DEADLINE_LOW_CONFIDENCE"));
}

// --- (6) unknowns非空 → 1問にまとめる(件数分は増やさない) ---
{
  const c = baseCandidate({
    completionCondition: "提出する",
    unknowns: ["提出先が複数解釈できる", "期限の年が不明"],
  });
  const qs = buildQuestionCandidatesForCandidate(c);
  const matches = qs.filter((x) => x.questionCode === "UNKNOWNS_CLARIFICATION");
  ok("unknowns複数件でも質問は1件にまとまる", matches.length === 1, `got ${matches.length}`);
}

// --- (7) P2(importance/desiredDate/description欠落)は現時点では自動発生しない ---
{
  const c = baseCandidate({
    type: "TASK",
    completionCondition: "提出する",
    importance: undefined,
    description: undefined,
    dateMentions: [],
  });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok("P2項目の単純欠落だけでは質問0件(構造化signal無しのため)", qs.length === 0, `got ${qs.map((q) => q.questionCode).join(",")}`);
}

// --- (7b) [M1-B6B新設] P2は構造化clarificationSignalが有る場合のみ発生する ---
{
  const c = baseCandidate({
    type: "TASK",
    completionCondition: "提出する",
    importance: undefined,
    clarificationSignals: [
      { field: "IMPORTANCE", ambiguity: 0.8, downstreamImpact: 0.7, errorRisk: 0.6, answerCost: 0.1 },
    ],
  });
  const qs = buildQuestionCandidatesForCandidate(c);
  const q = qs.find((x) => x.questionCode === "IMPORTANCE_MISSING");
  ok(
    "[是正の核心] IMPORTANCE構造化signal有り・importance未設定でIMPORTANCE_MISSINGが生成される",
    q !== undefined,
    `got ${qs.map((x) => x.questionCode).join(",")}`,
  );
  ok(
    "生成されたscoreComponentsはsignalの値をそのまま使う(questionPolicy.ts側の静的値ではない)",
    q?.scoreComponents.ambiguity === 0.8 && q?.scoreComponents.downstreamImpact === 0.7,
  );
}
{
  // 構造化signalがあっても、既にimportanceが設定済みなら聞く必要が無い。
  const c = baseCandidate({
    type: "TASK",
    completionCondition: "提出する",
    importance: 3,
    clarificationSignals: [
      { field: "IMPORTANCE", ambiguity: 0.8, downstreamImpact: 0.7, errorRisk: 0.6, answerCost: 0.1 },
    ],
  });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok(
    "[単なる空欄では質問しない、の裏返し] importance設定済みならsignalがあっても質問しない",
    !qs.some((x) => x.questionCode === "IMPORTANCE_MISSING"),
    `got ${qs.map((x) => x.questionCode).join(",")}`,
  );
}
{
  const c = baseCandidate({
    type: "TASK",
    completionCondition: "提出する",
    description: undefined,
    clarificationSignals: [
      { field: "DESCRIPTION", ambiguity: 0.5, downstreamImpact: 0.9, errorRisk: 0.9, answerCost: 0.05 },
    ],
  });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok(
    "DESCRIPTION構造化signal有り・description未設定でDESCRIPTION_MISSINGが生成される",
    qs.some((x) => x.questionCode === "DESCRIPTION_MISSING"),
    `got ${qs.map((x) => x.questionCode).join(",")}`,
  );
}
{
  const c = baseCandidate({
    type: "TASK",
    completionCondition: "提出する",
    dateMentions: [],
    clarificationSignals: [
      { field: "DESIRED_DATE", ambiguity: 0.5, downstreamImpact: 0.9, errorRisk: 0.9, answerCost: 0.05 },
    ],
  });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok(
    "DESIRED_DATE構造化signal有り・dateMentions空でDESIRED_DATE_MISSINGが生成される",
    qs.some((x) => x.questionCode === "DESIRED_DATE_MISSING"),
    `got ${qs.map((x) => x.questionCode).join(",")}`,
  );
}
{
  // signalのscoreがP2閾値未満なら、signalが有っても質問しない(既存の閾値機構が
  // 構造化signalにも変わらず適用されることの確認)。
  const c = baseCandidate({
    type: "TASK",
    completionCondition: "提出する",
    importance: undefined,
    clarificationSignals: [
      { field: "IMPORTANCE", ambiguity: 0.1, downstreamImpact: 0.1, errorRisk: 0.1, answerCost: 0.05 },
    ],
  });
  const qs = buildQuestionCandidatesForCandidate(c);
  ok(
    "signalのscoreがP2閾値(0.1)未満なら質問しない(未確定属性としてUI表示するだけ)",
    !qs.some((x) => x.questionCode === "IMPORTANCE_MISSING"),
    `got ${qs.map((x) => x.questionCode).join(",")}`,
  );
}

// --- (7c) [M1-B6B新設] ResponsibilityCandidateSchema: clarificationSignalsの
//          versioned parse契約(旧schema互換・未知field拒否)。 ---
{
  const validated = ResponsibilityCandidateSchema.safeParse({
    candidateId: "c1",
    type: "TASK",
    title: "旧形式のAI応答(clarificationSignalsフィールド自体が無い)",
    evidenceSpans: [{ start: 0, end: 5 }],
    confidence: 0.9,
  });
  ok(
    "[旧schema互換・dual-read] clarificationSignalsを含まない旧形式のAI応答もparse成功する",
    validated.success && validated.data.clarificationSignals.length === 0,
    JSON.stringify(validated),
  );
}
{
  const validated = ResponsibilityCandidateSchema.safeParse({
    candidateId: "c1",
    type: "TASK",
    title: "新形式・構造化signal付き",
    evidenceSpans: [{ start: 0, end: 5 }],
    confidence: 0.9,
    clarificationSignals: [
      { field: "IMPORTANCE", ambiguity: 0.5, downstreamImpact: 0.5, errorRisk: 0.5, answerCost: 0.1 },
    ],
  });
  ok("新形式(clarificationSignals有り)はparse成功する", validated.success);
}
{
  const validated = ResponsibilityCandidateSchema.safeParse({
    candidateId: "c1",
    type: "TASK",
    title: "未知fieldを含むclarificationSignals",
    evidenceSpans: [{ start: 0, end: 5 }],
    confidence: 0.9,
    clarificationSignals: [
      {
        field: "IMPORTANCE",
        ambiguity: 0.5,
        downstreamImpact: 0.5,
        errorRisk: 0.5,
        answerCost: 0.1,
        // [意図的] schemaが想定していない未知field。
        madeUpExtraField: "should be rejected",
      },
    ],
  });
  ok(
    "[是正の核心・想像で新語彙を受け入れない] 未知fieldを含むclarificationSignalsはparse失敗する",
    !validated.success,
  );
}
{
  const validated = ResponsibilityCandidateSchema.safeParse({
    candidateId: "c1",
    type: "TASK",
    title: "未知のfield値",
    evidenceSpans: [{ start: 0, end: 5 }],
    confidence: 0.9,
    clarificationSignals: [
      { field: "LOCATION", ambiguity: 0.5, downstreamImpact: 0.5, errorRisk: 0.5, answerCost: 0.1 },
    ],
  });
  ok(
    "[scope外・是正の核心] field=LOCATIONはCLARIFICATION_SIGNAL_FIELDSに含まれないためparse失敗する(Candidate側に対応fieldが無いため未対応)",
    !validated.success,
  );
}

// --- (8) score計算式 ---
{
  const s = computeQuestionScore({ ambiguity: 0.9, downstreamImpact: 0.8, errorRisk: 0.7, answerCost: 0.15 });
  const expected = 0.9 * 0.8 * 0.7 - 0.15;
  ok("computeQuestionScoreがambiguity*downstreamImpact*errorRisk-answerCostと一致",
    Math.abs(s - expected) < 1e-9, `got ${s} expected ${expected}`);
}

// --- (9) 閾値未満は除外される ---
{
  ok("QUESTION_SCORE_THRESHOLDSはP0/P1/P2すべて定義",
    ["P0", "P1", "P2"].every((p) => typeof QUESTION_SCORE_THRESHOLDS[p as "P0"] === "number"));
}

// --- (10) 最大3問/Session(4候補以上でも3件に制限) ---
{
  const inputs: SessionCandidateInput[] = [
    { candidateRef: "r1", createdOrder: 0, candidate: baseCandidate({ candidateId: "c1", type: "COMMITMENT", counterparty: undefined, title: "A" }) },
    { candidateRef: "r2", createdOrder: 1, candidate: baseCandidate({ candidateId: "c2", type: "COMMITMENT", counterparty: undefined, title: "B" }) },
    { candidateRef: "r3", createdOrder: 2, candidate: baseCandidate({ candidateId: "c3", type: "COMMITMENT", counterparty: undefined, title: "C" }) },
    { candidateRef: "r4", createdOrder: 3, candidate: baseCandidate({ candidateId: "c4", type: "COMMITMENT", counterparty: undefined, title: "D" }) },
  ];
  const selected = selectSessionQuestions(inputs, 3);
  ok("4候補全てP0該当でも選定は3件まで", selected.length === 3, `got ${selected.length}`);
  ok("tie-break: createdOrder昇順(同scoreの場合)でr1,r2,r3が選ばれる",
    selected.map((s) => s.candidateRef).join(",") === "r1,r2,r3",
    selected.map((s) => s.candidateRef).join(","));
}

// --- (11) remainingSlots=0なら質問0件(生涯上限到達) ---
{
  const inputs: SessionCandidateInput[] = [
    { candidateRef: "r1", createdOrder: 0, candidate: baseCandidate({ type: "COMMITMENT", counterparty: undefined }) },
  ];
  const selected = selectSessionQuestions(inputs, 0);
  ok("remainingSlots=0なら質問0件", selected.length === 0);
}

// --- (12) alreadyAskedは再質問しない ---
{
  const inputs: SessionCandidateInput[] = [
    { candidateRef: "r1", createdOrder: 0, candidate: baseCandidate({ type: "COMMITMENT", counterparty: undefined, completionCondition: "承認を得る" }) },
  ];
  const selected = selectSessionQuestions(inputs, 3, new Set(["r1::COMMITMENT_COUNTERPARTY_MISSING"]));
  ok("alreadyAskedにある(candidateRef,questionCode)は再質問しない", selected.length === 0);
}

// --- (13) 優先度tie-break: P0がP1より先(同candidateで両方該当するケースは無いため別candidateで検証) ---
{
  const inputs: SessionCandidateInput[] = [
    { candidateRef: "waiting", createdOrder: 0, candidate: baseCandidate({ type: "WAITING", counterparty: undefined, completionCondition: "返信を待つ" }) },
    { candidateRef: "commitment", createdOrder: 1, candidate: baseCandidate({ type: "COMMITMENT", counterparty: undefined }) },
  ];
  const selected = selectSessionQuestions(inputs, 1);
  ok("P0(COMMITMENT)がP1(WAITING)より先に選ばれる(createdOrderが後でもpriority優先)",
    selected.length === 1 && selected[0].candidateRef === "commitment",
    selected.map((s) => `${s.candidateRef}:${s.priority}`).join(","));
}

// --- (14) applyAnswerToCandidate: FREE_TEXTでcounterparty反映 ---
{
  const c = baseCandidate({ type: "COMMITMENT", counterparty: undefined });
  const updated = applyAnswerToCandidate(c, "COMMITMENT_COUNTERPARTY_MISSING", "FREE_TEXT", "山田さん");
  ok("FREE_TEXT回答でcounterpartyが反映される", updated.counterparty === "山田さん");
  ok("元のcandidateオブジェクトは変更されない(immutable)", c.counterparty === undefined);
}

// --- (15) applyAnswerToCandidate: UNKNOWN/DEFERRED/DO_NOT_MATERIALIZEはfieldを変えない ---
{
  const c = baseCandidate({ type: "COMMITMENT", counterparty: undefined });
  const u1 = applyAnswerToCandidate(c, "COMMITMENT_COUNTERPARTY_MISSING", "UNKNOWN", "山田さん");
  const u2 = applyAnswerToCandidate(c, "COMMITMENT_COUNTERPARTY_MISSING", "DEFERRED", "山田さん");
  const u3 = applyAnswerToCandidate(c, "COMMITMENT_COUNTERPARTY_MISSING", "DO_NOT_MATERIALIZE", "山田さん");
  ok("UNKNOWN回答はfieldを変えない", u1.counterparty === undefined);
  ok("DEFERRED回答はfieldを変えない", u2.counterparty === undefined);
  ok("DO_NOT_MATERIALIZE回答はfieldを変えない", u3.counterparty === undefined);
}

// --- (16) applyAnswerToCandidate: HARD_DEADLINE確認SELECTED ---
{
  const c = baseCandidate({
    dateMentions: [{ rawExpression: "来週中", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", confidence: 0.3 }],
  });
  const confirmed = applyAnswerToCandidate(c, "HARD_DEADLINE_LOW_CONFIDENCE", "SELECTED", "CONFIRM_HARD_DEADLINE");
  ok("締切確認でconfidenceが1に更新される", confirmed.dateMentions[0].confidence === 1);
  ok("締切確認でmeaningはHARD_DEADLINEのまま", confirmed.dateMentions[0].meaning === "HARD_DEADLINE");

  const denied = applyAnswerToCandidate(c, "HARD_DEADLINE_LOW_CONFIDENCE", "SELECTED", "NOT_A_DEADLINE");
  ok("締切否定でmeaningがUNKNOWNに変わる", denied.dateMentions[0].meaning === "UNKNOWN");
}

// --- (17) applyAnswerToCandidate: 空文字は反映しない ---
{
  const c = baseCandidate({ type: "COMMITMENT", counterparty: undefined });
  const updated = applyAnswerToCandidate(c, "COMMITMENT_COUNTERPARTY_MISSING", "FREE_TEXT", "   ");
  ok("空白のみのFREE_TEXTは反映しない", updated.counterparty === undefined);
}

// --- (18) getAnswerKindForQuestionCode: CLARIFYING UI用のRegistry参照export ---
{
  ok("getAnswerKindForQuestionCode: COMMITMENT_COUNTERPARTY_MISSINGはFREE_TEXT",
    getAnswerKindForQuestionCode("COMMITMENT_COUNTERPARTY_MISSING") === "FREE_TEXT");
  ok("getAnswerKindForQuestionCode: HARD_DEADLINE_LOW_CONFIDENCEはSELECTED",
    getAnswerKindForQuestionCode("HARD_DEADLINE_LOW_CONFIDENCE") === "SELECTED");
}

// --- (19) getStaticQuestionOptions: SELECTED質問のみoptionsを持つ ---
{
  const hardDeadlineOptions = getStaticQuestionOptions("HARD_DEADLINE_LOW_CONFIDENCE");
  ok("getStaticQuestionOptions: HARD_DEADLINE_LOW_CONFIDENCEは2件のoptions",
    hardDeadlineOptions?.length === 2, JSON.stringify(hardDeadlineOptions));
  ok("getStaticQuestionOptions: FREE_TEXT質問(COMMITMENT_COUNTERPARTY_MISSING)はundefined",
    getStaticQuestionOptions("COMMITMENT_COUNTERPARTY_MISSING") === undefined);
}

console.log(`\n=== 結果: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("失敗一覧:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
