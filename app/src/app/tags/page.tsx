import { AppShell } from "@/components/app/AppShell";
import { TagsAdminClient } from "@/components/admin/TagsAdminClient";

export default function TagsPage() {
  return (
    <AppShell>
      <TagsAdminClient />
    </AppShell>
  );
}
