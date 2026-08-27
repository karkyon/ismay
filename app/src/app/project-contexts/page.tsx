import { Suspense } from "react";
import { AppShell } from "@/components/app/AppShell";
import { ProjectContextsClient } from "@/components/projectContext/ProjectContextsClient";

// [2026-08-27新設・V5-M1-A UI] ResponsibilitiesClient(app/src/app/responsibilities/page.tsx)と
// 同じ理由でSuspenseへ包む。ProjectContextsClient自体はuseSearchParams()を使わないが、
// 将来lifecycleStateフィルタ等をURL Queryへ載せる拡張(仕様v5.0 21.2節GET一覧のクエリ)を
// 見込み、既存規約(prerender是正)に最初から合わせておく。
export default function ProjectContextsPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <ProjectContextsClient />
      </Suspense>
    </AppShell>
  );
}
