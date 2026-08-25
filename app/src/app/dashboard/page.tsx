import { Suspense } from "react";
import { DashboardClient } from "@/components/auth/DashboardClient";

// [2026-08-25 prerender是正] DashboardClientはuseSearchParams()を使用するため、
// Suspenseで包まないとnpm run build時にprerenderエラーになる
// (Next.js App Router仕様。Completion Gate 2.1とは無関係のベースライン障害)。
export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardClient />
    </Suspense>
  );
}
