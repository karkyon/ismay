import { Suspense } from "react";
import { AppShell } from "@/components/app/AppShell";
import { ResponsibilitiesClient } from "@/components/responsibility/ResponsibilitiesClient";

// [2026-08-25 prerender是正] ResponsibilitiesClientはuseSearchParams()を使用するため、
// Suspenseで包まないとnpm run build時にprerenderエラーになる
// (Next.js App Router仕様。Completion Gate 2.1とは無関係のベースライン障害)。
export default function ResponsibilitiesPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <ResponsibilitiesClient />
      </Suspense>
    </AppShell>
  );
}
