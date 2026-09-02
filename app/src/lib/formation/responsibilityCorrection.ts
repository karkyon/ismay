import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { RESPONSIBILITY_TYPES, initialStatusFor } from "@/lib/responsibility";

/**
 * V5-M1-C3 Materialized Responsibility Split Correction service。
 * 出典: `ISMAY_統合正本仕様書_v5_0.md` §11.4「分解Transaction」
 * 「本人が承認した場合のみ、元候補又は責任にSPLIT Correctionを追記し、新しい
 * Responsibility群とRelationを同一transactionで作る。元責任の履歴は削除しない。」
 * EVAL・受入テスト仕様書 EV-A-004「split transaction | relation/source/receipt
 * 整合、部分失敗0」。
 *
 * [対象範囲の明記] `splitCorrection.ts`はFormation Session domainの**候補**
 * (materialize前)の分解を扱う。このfileは既にmaterialize済みの**Responsibility
 * 本体**の分解(post-materialize split)を扱う。対象そのものが異なるため、
 * `formation_candidate_lineages`とは独立した`responsibility_correction_receipts`/
 * `responsibility_correction_result_items`を使う(混同しない)。
 *
 * [scope宣言・M1-C3B更新] correctionTypeの値としては"MERGE"を予約していたが、
 * [2026-09-02・M1-C3B]で実装した。ただしMergeはN source→1 resultという
 * SPLIT(1 source→N result)と非対称な入力形のため、独立したテーブル
 * (ResponsibilityMergeReceipt/ResponsibilityMergeSourceItem)を使う
 * `mergeResponsibilities`関数として実装する(下部参照。既存のformation_candidate_
 * merge_eventsがformation_candidate_lineagesとは別テーブルである既存パターンと
 * 同じ設計判断)。
 *
 * [設計方針・種別固有Detail] materialize.ts(Formation→Responsibility変換)自体が
 * TaskDetail等の種別固有Detail(TBL-007〜010)を作成しないのと同じ理由で、Splitで
 * 生成する子Responsibilityも種別固有Detailを作らない(既存の生成経路と同じ範囲に
 * 揃える。想像で新しい経路だけ範囲を広げない)。
 *
 * [設計方針・Relation/Tag/ProjectContextLinkの複製] 正本は「新しいResponsibility群と
 * Relationを同一transactionで作る」とのみ規定し、複製の詳細ルールは明記していない。
 * 「依存関係を1つ失う実害」の方が「Tag/Relation/Linkが重複する実害」より大きいと
 * 判断し、元Responsibilityが持つ全Tag・全ResponsibilityRelation(from/to両方向)・
 * 全active ProjectContextLinkを、生成される各子Responsibilityへそのまま複製する
 * (理由をコード内に明記、想像で一方だけ複製しない)。
 *
 * [設計方針・RecurrenceRule] 定期責任(RecurrenceRuleを持つResponsibility)の分割は、
 * 「各子がどう繰り返すか」の意味論が正本に定義されていないため拒否する
 * (想像でセマンティクスを作らない)。
 *
 * [設計方針・元Responsibilityの扱い] 元Responsibilityは物理削除せず、
 * `supersededByReceiptId`のみ設定する。既存statusの値集合に「分割済み」に対応する
 * 語彙が無いため、想像で近い意味の既存値(NOT_NEEDED等)を流用せず、statusは変更しない
 * (§11.4「元責任の履歴は削除しない」の直接的な実装)。
 *
 * db.ts を直接importして良い(このファイルはtransitions/route.ts等と同じくAPI route
 * から呼ばれるservice層であり、db非依存pure testの対象ではないため)。
 */

export interface SplitResponsibilityPartInput {
  type: string;
  title: string;
  description?: string;
}

export interface SplitResponsibilityParams {
  workspaceId: string;
  sourceResponsibilityId: string;
  /** 分解対象を固定するため、クライアントが直前に見ていたversionを渡す
   *  (transitions/route.tsの`version`と同じ楽観ロック設計)。 */
  expectedVersion: number;
  parts: SplitResponsibilityPartInput[];
  reasonCode?: string;
  actorUserId: string;
  /** project-contexts/[id]/links/route.tsと同じIdempotency-Keyヘッダ契約。 */
  idempotencyKey: string;
  requestPayloadHash: string;
}

export interface SplitResponsibilityNewItem {
  id: string;
  type: string;
  title: string;
  status: string;
}

export type SplitResponsibilityResult =
  | { ok: true; receiptId: string; sourceResponsibilityId: string; newResponsibilities: SplitResponsibilityNewItem[]; replay: boolean }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "VERSION_CONFLICT"; latestVersion: number }
  | { ok: false; error: "ALREADY_SPLIT"; receiptId: string }
  | { ok: false; error: "HAS_RECURRENCE_RULE" }
  | { ok: false; error: "IDEMPOTENCY_KEY_REUSED" }
  /** §3.2条件「独立して完了判定できる成果を複数内包しない」の裏返しとして、
   *  分解には最低2つの独立した部分が必要(1つしか無ければ分解にならない)。 */
  | { ok: false; error: "INVALID_SPLIT_PARTS"; reason: string };

const RESPONSIBILITY_TYPE_SET = new Set<string>(RESPONSIBILITY_TYPES);

function validateParts(parts: SplitResponsibilityPartInput[]): string | null {
  if (parts.length < 2) {
    return "分解には2件以上の部分が必要です";
  }
  for (const [i, part] of parts.entries()) {
    if (!RESPONSIBILITY_TYPE_SET.has(part.type)) {
      return `parts[${i}].typeが不正です: ${part.type}`;
    }
    if (!part.title || part.title.trim().length === 0) {
      return `parts[${i}].titleが空です`;
    }
  }
  return null;
}

export async function splitResponsibility(params: SplitResponsibilityParams): Promise<SplitResponsibilityResult> {
  const { workspaceId, sourceResponsibilityId, expectedVersion, parts, reasonCode, actorUserId, idempotencyKey, requestPayloadHash } = params;

  const partsError = validateParts(parts);
  if (partsError) {
    return { ok: false, error: "INVALID_SPLIT_PARTS", reason: partsError };
  }

  // [冪等再送判定・project-contexts/[id]/links/route.tsと同じ設計] 全ての検証・
  // 書き込みより前に、idempotencyKeyの既存Receiptを確認する。
  const existingReceipt = await db.responsibilityCorrectionReceipt.findFirst({
    where: { workspaceId, idempotencyKey },
    select: { id: true, requestPayloadHash: true, sourceResponsibilityId: true },
  });
  if (existingReceipt) {
    if (existingReceipt.requestPayloadHash !== requestPayloadHash) {
      return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
    }
    const items = await db.responsibilityCorrectionResultItem.findMany({
      where: { workspaceId, receiptId: existingReceipt.id },
      include: { newResponsibility: { select: { id: true, type: true, title: true, status: true } } },
      orderBy: { createdAt: "asc" },
    });
    return {
      ok: true,
      receiptId: existingReceipt.id,
      sourceResponsibilityId: existingReceipt.sourceResponsibilityId,
      newResponsibilities: items.map((it: { newResponsibility: { id: string; type: string; title: string; status: string } }) => ({
        id: it.newResponsibility.id,
        type: it.newResponsibility.type,
        title: it.newResponsibility.title,
        status: it.newResponsibility.status,
      })),
      replay: true,
    };
  }

  return await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const source = await tx.responsibility.findFirst({
      where: { id: sourceResponsibilityId, workspaceId, deletedAt: null },
      include: {
        tags: { select: { tagId: true } },
        recurrenceRule: { select: { id: true } },
        relationsFrom: { where: { deletedAt: null } },
        relationsTo: { where: { deletedAt: null } },
        projectContextLinks: { where: { unlinkedAt: null } },
      },
    });
    if (!source) return { ok: false, error: "NOT_FOUND" } as const;

    if (source.version !== expectedVersion) {
      return { ok: false, error: "VERSION_CONFLICT", latestVersion: source.version } as const;
    }
    if (source.supersededByReceiptId) {
      return { ok: false, error: "ALREADY_SPLIT", receiptId: source.supersededByReceiptId } as const;
    }
    // [設計方針・RecurrenceRule参照] 定期責任の分割意味論は正本未定義のため拒否する。
    if (source.recurrenceRule) {
      return { ok: false, error: "HAS_RECURRENCE_RULE" } as const;
    }

    // [楽観ロック] transitions/route.tsと同じupdateMany+count===0判定パターン。
    const lockResult = await tx.responsibility.updateMany({
      where: { id: sourceResponsibilityId, workspaceId, version: expectedVersion },
      data: { version: { increment: 1 } },
    });
    if (lockResult.count === 0) {
      const latest = await tx.responsibility.findUnique({ where: { id: sourceResponsibilityId }, select: { version: true } });
      return { ok: false, error: "VERSION_CONFLICT", latestVersion: latest?.version ?? expectedVersion } as const;
    }

    const receipt = await tx.responsibilityCorrectionReceipt.create({
      data: {
        workspaceId,
        sourceResponsibilityId,
        correctionType: "SPLIT",
        expectedVersion,
        idempotencyKey,
        requestPayloadHash,
        reasonCode: reasonCode ?? null,
        actorUserId,
      },
    });

    // [§11.4「元候補又は責任にSPLIT Correctionを追記し」] 元責任の履歴は削除せず、
    // supersededByReceiptIdのみ設定する。
    await tx.responsibility.update({
      where: { id: sourceResponsibilityId },
      data: { supersededByReceiptId: receipt.id },
    });

    const newResponsibilities: SplitResponsibilityNewItem[] = [];
    for (const part of parts) {
      const child = await tx.responsibility.create({
        data: {
          workspaceId,
          domainId: source.domainId,
          originCaptureId: source.originCaptureId,
          type: part.type,
          title: part.title,
          description: part.description ?? null,
          status: initialStatusFor(part.type),
          importance: source.importance,
          // [設計判断] 本人がSPLIT操作で確定した内容のため、AI由来のconfidenceを
          // 引き継がない(splitCorrection.tsの子候補confidence=1と同じ考え方)。
          confidence: null,
          sourceKind: "USER",
          createdById: actorUserId,
          updatedById: actorUserId,
        },
      });

      await tx.responsibilityCorrectionResultItem.create({
        data: { workspaceId, receiptId: receipt.id, newResponsibilityId: child.id },
      });

      // [Tag複製] 元の全Tagをそのまま複製する。
      if (source.tags.length > 0) {
        await tx.responsibilityTag.createMany({
          data: source.tags.map((t: { tagId: string }) => ({ responsibilityId: child.id, tagId: t.tagId })),
        });
      }

      // [Relation複製・両方向] 元がfromId/toIdとして持つ全ResponsibilityRelationを
      // 各子へ複製する(重複の実害 < 依存関係を失う実害、という設計判断。上部コメント参照)。
      for (const rel of source.relationsFrom) {
        await tx.responsibilityRelation.create({
          data: {
            fromId: child.id,
            toId: rel.toId,
            relationType: rel.relationType,
            status: rel.status,
            confidence: rel.confidence,
            sourceKind: rel.sourceKind,
            sourceRef: rel.sourceRef,
            confirmedById: rel.confirmedById,
            confirmedAt: rel.confirmedAt,
          },
        });
      }
      for (const rel of source.relationsTo) {
        await tx.responsibilityRelation.create({
          data: {
            fromId: rel.fromId,
            toId: child.id,
            relationType: rel.relationType,
            status: rel.status,
            confidence: rel.confidence,
            sourceKind: rel.sourceKind,
            sourceRef: rel.sourceRef,
            confirmedById: rel.confirmedById,
            confirmedAt: rel.confirmedAt,
          },
        });
      }

      // [ProjectContextLink複製] project-contexts/[id]/links/route.tsと同じく、
      // Link行と対応するLinkEvent(LINK)を同一transaction内で必ず両方作る
      // (ProjectContextLinkEventが履歴の正本、ProjectContextLinkはそのProjection)。
      // PRIMARY roleはresponsibilityId単位で一意制約されるため、子ごとに
      // responsibilityIdが異なるここでは競合しない。
      for (const link of source.projectContextLinks) {
        const newLink = await tx.projectContextLink.create({
          data: {
            workspaceId,
            contextId: link.contextId,
            responsibilityId: child.id,
            role: link.role,
            sourceKind: link.sourceKind,
          },
        });
        await tx.projectContextLinkEvent.create({
          data: {
            workspaceId,
            contextId: link.contextId,
            responsibilityId: child.id,
            eventType: "LINK",
            role: link.role,
            afterSnapshot: { role: link.role, sourceKind: newLink.sourceKind, linkedAt: newLink.linkedAt.toISOString(), splitFromResponsibilityId: sourceResponsibilityId },
            actorType: "USER",
            actorUserId,
            // [2026-09-02バグ修正・実DB検証で発覚] 当初`${idempotencyKey}:link:${link.id}`
            // (元sourceのlink.id、childごとに不変の固定値)としており、parts配列が
            // 複数の場合、child1とchild2で同じidempotencyKeyになり
            // ProjectContextLinkEventのunique制約(workspace_id, context_id,
            // idempotency_key)違反(P2002)を起こしていた。child.id(子ごとに固有)を
            // 含めて衝突しないようにする。
            idempotencyKey: `${idempotencyKey}:link:${child.id}:${link.id}`,
            requestPayloadHash,
          },
        });
      }

      newResponsibilities.push({ id: child.id, type: child.type, title: child.title, status: child.status });
    }

    await tx.eventLog.create({
      data: {
        aggregateType: "Responsibility",
        aggregateId: sourceResponsibilityId,
        eventType: "RESPONSIBILITY_SPLIT",
        beforeJson: { status: source.status, version: expectedVersion },
        afterJson: { receiptId: receipt.id, newResponsibilityIds: newResponsibilities.map((r) => r.id) },
        actorType: "USER",
        actorId: actorUserId,
        reason: reasonCode,
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventName: "ResponsibilitySplit.v1",
        eventVersion: "1",
        aggregateId: sourceResponsibilityId,
        aggregateVersion: expectedVersion + 1,
        payload: { sourceResponsibilityId, receiptId: receipt.id, newResponsibilityIds: newResponsibilities.map((r) => r.id) },
      },
    });

    debugServer.event("formation/responsibilityCorrection", "RESPONSIBILITY_SPLIT", {
      sourceResponsibilityId,
      receiptId: receipt.id,
      newCount: newResponsibilities.length,
    });

    return {
      ok: true,
      receiptId: receipt.id,
      sourceResponsibilityId,
      newResponsibilities,
      replay: false,
    } as const;
  });
}

/**
 * V5-M1-C3B Materialized Responsibility Merge Correction service。
 * 出典: 統合正本仕様書v5.0 §12.8「本人がACCEPT/EDIT/REJECT/MERGE/SPLITした結果を
 * Feedbackとして蓄積する」、§11.4の分解Transaction原則を統合方向にも適用する。
 *
 * [対象範囲の明記] `mergeCorrection.ts`はFormation Session domainの**候補**
 * (materialize前)の統合を扱う。この関数は既にmaterialize済みの**Responsibility
 * 本体**の統合(post-materialize merge)を扱う(splitResponsibilityと対称)。
 *
 * [設計方針・独立テーブル] N source→1 resultという入力形がSPLIT(1 source→N
 * result)と非対称なため、`ResponsibilityCorrectionReceipt`は流用せず独立した
 * `ResponsibilityMergeReceipt`/`ResponsibilityMergeSourceItem`を使う(schema.prisma
 * コメント参照)。
 *
 * [設計方針・domainId不一致] 統合先のdomainIdを想像で決めない。全sourceの
 * domainIdが完全一致する場合のみ許可し、不一致ならDOMAIN_MISMATCHで拒否する。
 *
 * [設計方針・Merge対象間の自己参照Relation除外] source同士が互いに持っていた
 * ResponsibilityRelation(例: sourceA BLOCKS sourceB)は、統合後は同一
 * Responsibilityへの自己参照になり意味を持たないため複製しない。
 *
 * [設計方針・ProjectContextLink統合] 複数sourceが同一Contextへ異なるroleで
 * リンクしていた場合、最も強いrole(PRIMARY > SUPPORTING > REFERENCE)を1件だけ
 * 採用する(contextIdごとに集約、重複Link作成を避ける)。複数の異なるContextへの
 * PRIMARY Linkが複数sourceにまたがって存在した場合、新Responsibility 1件は
 * active PRIMARYを最大1件しか持てない(project-contexts/[id]/links/route.tsの
 * 制約と同じ)ため、最初に処理されたsourceのPRIMARYのみを残し、以降のPRIMARYは
 * SUPPORTINGへ格下げして複製する(想像で優先順位を決めず、処理順=sources配列の
 * 指定順という決定論的な基準を採用し、コメントで明記する)。
 *
 * [設計方針・種別固有Detail/RecurrenceRule] splitResponsibilityと同じ理由
 * (上部コメント参照)で、種別固有Detailは作らず、RecurrenceRuleを持つsourceは
 * 拒否する。
 */

export interface MergeSourceInput {
  responsibilityId: string;
  expectedVersion: number;
}

export interface MergeResponsibilitiesParams {
  workspaceId: string;
  sources: MergeSourceInput[];
  newType: string;
  newTitle: string;
  newDescription?: string;
  reasonCode?: string;
  actorUserId: string;
  idempotencyKey: string;
  requestPayloadHash: string;
}

export type MergeResponsibilitiesResult =
  | { ok: true; receiptId: string; newResponsibilityId: string; replay: boolean }
  | { ok: false; error: "NOT_FOUND"; responsibilityId: string }
  | { ok: false; error: "VERSION_CONFLICT"; responsibilityId: string; latestVersion: number }
  | { ok: false; error: "ALREADY_SPLIT_OR_MERGED"; responsibilityId: string; receiptId: string }
  | { ok: false; error: "HAS_RECURRENCE_RULE"; responsibilityId: string }
  | { ok: false; error: "DOMAIN_MISMATCH" }
  | { ok: false; error: "IDEMPOTENCY_KEY_REUSED" }
  | { ok: false; error: "INVALID_MERGE_SOURCES"; reason: string };

const ROLE_PRIORITY: Record<string, number> = { PRIMARY: 3, SUPPORTING: 2, REFERENCE: 1 };

function validateMergeSources(sources: MergeSourceInput[], newType: string, newTitle: string): string | null {
  if (sources.length < 2) {
    return "統合には2件以上のsourceが必要です";
  }
  const ids = new Set<string>();
  for (const s of sources) {
    if (ids.has(s.responsibilityId)) {
      return `sourceが重複しています: ${s.responsibilityId}`;
    }
    ids.add(s.responsibilityId);
  }
  if (!RESPONSIBILITY_TYPE_SET.has(newType)) {
    return `newTypeが不正です: ${newType}`;
  }
  if (!newTitle || newTitle.trim().length === 0) {
    return "newTitleが空です";
  }
  return null;
}

export async function mergeResponsibilities(params: MergeResponsibilitiesParams): Promise<MergeResponsibilitiesResult> {
  const { workspaceId, sources, newType, newTitle, newDescription, reasonCode, actorUserId, idempotencyKey, requestPayloadHash } = params;

  const sourcesError = validateMergeSources(sources, newType, newTitle);
  if (sourcesError) {
    return { ok: false, error: "INVALID_MERGE_SOURCES", reason: sourcesError };
  }

  // [冪等再送判定] splitResponsibilityと同じ設計。
  const existingReceipt = await db.responsibilityMergeReceipt.findFirst({
    where: { workspaceId, idempotencyKey },
    select: { id: true, requestPayloadHash: true, newResponsibilityId: true },
  });
  if (existingReceipt) {
    if (existingReceipt.requestPayloadHash !== requestPayloadHash) {
      return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
    }
    return { ok: true, receiptId: existingReceipt.id, newResponsibilityId: existingReceipt.newResponsibilityId, replay: true };
  }

  return await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const sourceIds = sources.map((s) => s.responsibilityId);
    const sourceResponsibilities = await tx.responsibility.findMany({
      where: { id: { in: sourceIds }, workspaceId, deletedAt: null },
      include: {
        tags: { select: { tagId: true } },
        recurrenceRule: { select: { id: true } },
        relationsFrom: { where: { deletedAt: null } },
        relationsTo: { where: { deletedAt: null } },
        projectContextLinks: { where: { unlinkedAt: null } },
      },
    });
    // [2026-09-02是正・実サーバーtsc検証で発覚] 当初厳密な型注釈を書いていたが、
    // 実際のPrisma生成型(sourceKindがString?でnullable、confidenceがPrisma.Decimal
    // 型)と食い違い、実サーバーのtscでのみ検出される型エラーになった(sandboxのany
    // スタブでは検出不可能だった既知の限界。userMemories「Prisma real-server-only
    // errors」参照)。ESLint no-explicit-anyのためanyキャストも使えず、型注釈を
    // 一切付けずPrisma生成型の推論にそのまま委ねる(materialize.ts等の既存パターンと
    // 同じ、sandboxではimplicit anyのtscノイズが出るがbaselineへ許容登録する)。
    const byId = new Map(sourceResponsibilities.map((r) => [r.id, r]));

    for (const s of sources) {
      const found = byId.get(s.responsibilityId);
      if (!found) return { ok: false, error: "NOT_FOUND", responsibilityId: s.responsibilityId } as const;
      if (found.version !== s.expectedVersion) {
        return { ok: false, error: "VERSION_CONFLICT", responsibilityId: s.responsibilityId, latestVersion: found.version } as const;
      }
      // [2026-09-02是正・実サーバーtsc検証で発覚] `found.supersededByReceiptId ||
      // found.supersededByMergeReceiptId`という2つの独立したnullableプロパティの
      // 論理和では、TypeScriptの型ナローイングがそのifブロック内で`??`式の結果を
      // non-nullと推論できない(receiptId: string|nullのまま)。単一変数へ束ねてから
      // truthyチェックすることで、TS標準のnarrowingがreceiptId: stringへ正しく
      // 絞り込めるようにする。
      const supersededReceiptId = found.supersededByReceiptId ?? found.supersededByMergeReceiptId;
      if (supersededReceiptId) {
        return {
          ok: false,
          error: "ALREADY_SPLIT_OR_MERGED",
          responsibilityId: s.responsibilityId,
          receiptId: supersededReceiptId,
        } as const;
      }
      if (found.recurrenceRule) {
        return { ok: false, error: "HAS_RECURRENCE_RULE", responsibilityId: s.responsibilityId } as const;
      }
    }

    // [2026-09-02重要バグ修正・徹底再検証で発覚] `tx.responsibility.findMany`の
    // 結果配列(sourceResponsibilities)の順序は、Prisma/PostgreSQLがorderByを
    // 指定しない限り保証されない(`id: { in: sourceIds }`のin句の指定順とは
    // 一致しない可能性がある)。一方、下部のPRIMARY Link競合解決ロジックは
    // 「sources引数(呼び出し元が指定した順序)で最初に見つかったものを残す」という
    // 決定論的な設計を意図しており(コメント参照)、この2つの前提が食い違うと、
    // DB内部順序次第でどのsourceのPRIMARYが残るかが非決定的になってしまう
    // (verify_gate_m1c3b_responsibility_merge.tsシナリオ[B]がs1固定を期待している
    // ため、環境によってflaky failureを起こしうる重大な潜在バグだった)。
    // sources引数の順序に厳密に従った配列を作り、以降の全ての処理(domainId確認・
    // importance算出・Tag/Relation/ProjectContextLink統合)をこちらで行う。
    // [安全性] 上のforループで全sourceの存在(NOT_FOUND)を確認済みのため、この
    // 時点でbyId.get(...)が undefined を返すことはない(non-null assertionは
    // ここでのみ安全)。構築位置を検証ループの"後"に置くことで、将来ロジックが
    // 変更されてもundefinedのまま使われるリスクを避ける。
    const orderedSources = sources.map((s) => byId.get(s.responsibilityId)!);

    const domainIds = new Set(orderedSources.map((r) => r.domainId));
    if (domainIds.size > 1) {
      return { ok: false, error: "DOMAIN_MISMATCH" } as const;
    }
    const commonDomainId = orderedSources[0].domainId;

    // [楽観ロック] 全sourceを一括でversion+1する。
    for (const s of sources) {
      const lockResult = await tx.responsibility.updateMany({
        where: { id: s.responsibilityId, workspaceId, version: s.expectedVersion },
        data: { version: { increment: 1 } },
      });
      if (lockResult.count === 0) {
        const latest = await tx.responsibility.findUnique({ where: { id: s.responsibilityId }, select: { version: true } });
        return { ok: false, error: "VERSION_CONFLICT", responsibilityId: s.responsibilityId, latestVersion: latest?.version ?? s.expectedVersion } as const;
      }
    }

    // importanceは統合対象の最大値を採用する(重要度が下がる方向へ想像で丸めない)。
    const maxImportance = orderedSources.reduce(
      (max: number | null, r) => (r.importance !== null && (max === null || r.importance > max) ? r.importance : max),
      null as number | null,
    );

    const merged = await tx.responsibility.create({
      data: {
        workspaceId,
        domainId: commonDomainId,
        originCaptureId: orderedSources[0].originCaptureId,
        type: newType,
        title: newTitle,
        description: newDescription ?? null,
        status: initialStatusFor(newType),
        importance: maxImportance,
        confidence: null,
        sourceKind: "USER",
        createdById: actorUserId,
        updatedById: actorUserId,
      },
    });

    const receipt = await tx.responsibilityMergeReceipt.create({
      data: {
        workspaceId,
        newResponsibilityId: merged.id,
        idempotencyKey,
        requestPayloadHash,
        reasonCode: reasonCode ?? null,
        actorUserId,
      },
    });

    for (const s of sources) {
      await tx.responsibilityMergeSourceItem.create({
        data: { workspaceId, receiptId: receipt.id, sourceResponsibilityId: s.responsibilityId, expectedVersion: s.expectedVersion },
      });
      await tx.responsibility.update({
        where: { id: s.responsibilityId },
        data: { supersededByMergeReceiptId: receipt.id },
      });
    }

    // [Tag統合] 全sourceのTagの和集合(重複除去)を新Responsibilityへ複製する。
    const tagIds = new Set<string>();
    for (const r of orderedSources) {
      for (const t of r.tags) tagIds.add(t.tagId);
    }
    if (tagIds.size > 0) {
      await tx.responsibilityTag.createMany({
        data: [...tagIds].map((tagId) => ({ responsibilityId: merged.id, tagId })),
      });
    }

    // [Relation統合・自己参照除外] source同士の間のRelationは統合後に自己参照に
    // なるため複製しない(上部コメント参照)。
    const sourceIdSet = new Set(sourceIds);
    const seenRelations = new Set<string>();
    for (const r of orderedSources) {
      for (const rel of r.relationsFrom) {
        if (sourceIdSet.has(rel.toId)) continue;
        const key = `from:${rel.toId}:${rel.relationType}`;
        if (seenRelations.has(key)) continue;
        seenRelations.add(key);
        await tx.responsibilityRelation.create({
          data: {
            fromId: merged.id,
            toId: rel.toId,
            relationType: rel.relationType,
            status: rel.status,
            confidence: rel.confidence,
            sourceKind: rel.sourceKind,
            sourceRef: rel.sourceRef,
            confirmedById: rel.confirmedById,
            confirmedAt: rel.confirmedAt,
          },
        });
      }
      for (const rel of r.relationsTo) {
        if (sourceIdSet.has(rel.fromId)) continue;
        const key = `to:${rel.fromId}:${rel.relationType}`;
        if (seenRelations.has(key)) continue;
        seenRelations.add(key);
        await tx.responsibilityRelation.create({
          data: {
            fromId: rel.fromId,
            toId: merged.id,
            relationType: rel.relationType,
            status: rel.status,
            confidence: rel.confidence,
            sourceKind: rel.sourceKind,
            sourceRef: rel.sourceRef,
            confirmedById: rel.confirmedById,
            confirmedAt: rel.confirmedAt,
          },
        });
      }
    }

    // [ProjectContextLink統合] contextIdごとに最も強いroleを1件採用する。
    // 複数sourceにまたがるPRIMARYの競合は、sources配列の指定順で最初に見つかった
    // ものだけをPRIMARYとして残し、以降はSUPPORTINGへ格下げする(上部コメント参照)。
    const contextLinkMap = new Map<string, { role: string; sourceKind: string }>();
    let primaryAssigned = false;
    for (const r of orderedSources) {
      for (const link of r.projectContextLinks) {
        const existing = contextLinkMap.get(link.contextId);
        let effectiveRole = link.role;
        if (effectiveRole === "PRIMARY") {
          if (primaryAssigned) {
            effectiveRole = "SUPPORTING";
          } else {
            primaryAssigned = true;
          }
        }
        if (!existing || (ROLE_PRIORITY[effectiveRole] ?? 0) > (ROLE_PRIORITY[existing.role] ?? 0)) {
          contextLinkMap.set(link.contextId, { role: effectiveRole, sourceKind: link.sourceKind });
        }
      }
    }
    for (const [contextId, info] of contextLinkMap) {
      const newLink = await tx.projectContextLink.create({
        data: { workspaceId, contextId, responsibilityId: merged.id, role: info.role, sourceKind: info.sourceKind },
      });
      await tx.projectContextLinkEvent.create({
        data: {
          workspaceId,
          contextId,
          responsibilityId: merged.id,
          eventType: "LINK",
          role: info.role,
          afterSnapshot: { role: info.role, sourceKind: newLink.sourceKind, linkedAt: newLink.linkedAt.toISOString(), mergedFromResponsibilityIds: sourceIds },
          actorType: "USER",
          actorUserId,
          idempotencyKey: `${idempotencyKey}:link:${contextId}`,
          requestPayloadHash,
        },
      });
    }

    await tx.eventLog.create({
      data: {
        aggregateType: "Responsibility",
        aggregateId: merged.id,
        eventType: "RESPONSIBILITY_MERGED",
        beforeJson: { sourceResponsibilityIds: sourceIds },
        afterJson: { receiptId: receipt.id, newResponsibilityId: merged.id },
        actorType: "USER",
        actorId: actorUserId,
        reason: reasonCode,
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventName: "ResponsibilityMerged.v1",
        eventVersion: "1",
        aggregateId: merged.id,
        aggregateVersion: 0,
        payload: { newResponsibilityId: merged.id, receiptId: receipt.id, sourceResponsibilityIds: sourceIds },
      },
    });

    debugServer.event("formation/responsibilityCorrection", "RESPONSIBILITY_MERGED", {
      newResponsibilityId: merged.id,
      receiptId: receipt.id,
      sourceCount: sources.length,
    });

    return { ok: true, receiptId: receipt.id, newResponsibilityId: merged.id, replay: false } as const;
  });
}
