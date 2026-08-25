import { Suspense } from "react";
import { AppShell } from "@/components/app/AppShell";
import { InboxClient } from "@/components/capture/InboxClient";

// [2026-08-25 prerender是正] InboxClientはuseSearchParams()を使用するため、
// Suspenseで包まないとnpm run build時にprerenderエラーになる
// (Next.js App Router仕様。Completion Gate 2.1とは無関係のベースライン障害)。
export default function InboxPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <InboxClient />
      </Suspense>
    </AppShell>
  );
}
