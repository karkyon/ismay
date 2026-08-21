import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";

/**
 * Outbox Worker(システム基本設計書v1.2 8.3節「Outbox Workerがイベントを配送し、
 * 購読側はEvent IDで重複排除する」)の最小実装。
 *
 * 対象イベント: CaptureAnalysisRequested.v1 → Job(jobType=AI_EXTRACT)
 * Jobの冪等キーは (jobType, aggregateId, sourceVersion) の一意制約(schema.prisma既存定義)で
 * 保証する。同じOutboxEventが二重にリレーされても、DB制約違反として無視される。
 */

const RELAY_BATCH_SIZE = 20;
const RELAYED_EVENT_TO_JOB_TYPE: Record<string, string> = {
  "CaptureAnalysisRequested.v1": "AI_EXTRACT",
  "AudioTranscriptionRequested.v1": "TRANSCRIBE_AUDIO",
  "ImageOcrRequested.v1": "OCR_IMAGE",
};

export async function relayOutboxToJobs(): Promise<{ relayed: number }> {
  const pending = await db.outboxEvent.findMany({
    where: { status: "PENDING", eventName: { in: Object.keys(RELAYED_EVENT_TO_JOB_TYPE) } },
    orderBy: { createdAt: "asc" },
    take: RELAY_BATCH_SIZE,
  });

  let relayed = 0;
  for (const event of pending) {
    const jobType = RELAYED_EVENT_TO_JOB_TYPE[event.eventName];
    try {
      await db.$transaction(async (tx) => {
        await tx.job.create({
          data: {
            jobType,
            aggregateId: event.aggregateId,
            sourceVersion: event.aggregateVersion,
            payload: { captureId: event.aggregateId },
          },
        });
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { status: "PUBLISHED", publishedAt: new Date() },
        });
      });
      debugServer.event("Worker/relay", "OutboxEvent→Job", { eventId: event.id, aggregateId: event.aggregateId, jobType });
      debugServer.state("Worker/relay", "OutboxEvent.status", { eventId: event.id, status: "PUBLISHED" });
      relayed++;
    } catch (err: unknown) {
      // P2002(一意制約違反) = 既にJob化済み。OutboxEventだけPUBLISHEDへ進める。
      const code = (err as { code?: string } | null)?.code;
      if (code === "P2002") {
        await db.outboxEvent.update({
          where: { id: event.id },
          data: { status: "PUBLISHED", publishedAt: new Date() },
        });
        debugServer.state("Worker/relay", "OutboxEvent.status", {
          eventId: event.id,
          status: "PUBLISHED",
          note: "既にJob化済み(P2002)",
        });
        continue;
      }
      // その他の失敗はこのtickでは諦め、次回tickで再試行する(OutboxEventはPENDINGのまま)。
      debugServer.error("Worker/relay", "relayOutboxToJobsリレー失敗", { eventId: event.id, err });
    }
  }

  return { relayed };
}
