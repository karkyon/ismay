/**
 * PEM 個別Evidence削除 service(v5新設)。
 * 出典: PEMサブシステム統合正本仕様書v4.0 16.3節・16.4節、
 * DOC-09(Consent・Data Governance仕様書) 9章「deletion graphの全nodeが完了
 * または明示retain reasonを持つ」。
 *
 * [背景] evidenceDeletionCascade.ts冒頭コメントに明記されている通り、
 * PemObservationの削除書き込みはこれまでPOST /pem/reset(全件一括リセット)の
 * 1箇所のみで、「部分的な証拠削除→関連する仮説・週次レビューだけを選択的に
 * 無効化する」個別削除APIは存在しなかった。本ファイルがそれを実装する
 * (route.ts本体からロジックを分離し、直接テスト可能にする)。
 *
 * [scope宣言] deletionModeは既存のreset/route.tsと同じ"EXCLUDED_FROM_USE"
 * 固定とする。EVIDENCE_DELETION_MODESの他の値(REDACTED/ANONYMIZED/
 * CRYPTOGRAPHICALLY_ERASED/PHYSICALLY_DELETED/LEGALLY_RETAINED)は、それぞれ
 * 異なる実処理(実データの書き換え・暗号学的消去・物理削除等)を要し、正本に
 * API契約の詳細が無いため想像で実装しない。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getDeletedEvidenceIds } from "./evidenceDeletion";
import { propagateEvidenceDeletion, type PropagateEvidenceDeletionResult } from "./evidenceDeletionCascade";

export interface DeleteObservationEvidenceParams {
  userId: string;
  observationId: string;
  reason?: string;
}

export type DeleteObservationEvidenceResult =
  | ({ ok: true; alreadyDeleted: false } & PropagateEvidenceDeletionResult)
  | { ok: true; alreadyDeleted: true }
  | { ok: false; error: "NOT_FOUND" };

/**
 * userId本人が所有するPemObservation 1件を削除する(insert-only、
 * PemEvidenceDeletionEvent追記)。既に削除済みなら冪等にno-opを返す
 * (v4.0 16.3節のinsert-only精神: 同じ対象への複数回の削除要求は、
 * 2回目以降は実質的なno-opとして扱うのが安全)。
 */
export async function deleteObservationEvidence(
  params: DeleteObservationEvidenceParams,
): Promise<DeleteObservationEvidenceResult> {
  const { userId, observationId, reason } = params;

  const observation = await db.pemObservation.findFirst({ where: { id: observationId, userId } });
  if (!observation) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const deletedIds = await getDeletedEvidenceIds("PEM_OBSERVATION", userId);
  if (deletedIds.has(observationId)) {
    return { ok: true, alreadyDeleted: true };
  }

  const cascade = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.pemEvidenceDeletionEvent.create({
      data: {
        userId,
        targetType: "PEM_OBSERVATION",
        targetId: observationId,
        deletionMode: "EXCLUDED_FROM_USE",
        reason,
      },
    });
    return propagateEvidenceDeletion(tx, userId, [observationId]);
  });

  return { ok: true, alreadyDeleted: false, ...cascade };
}
