import { AppShell } from "@/components/app/AppShell";
import { RelationGraphClient } from "@/components/responsibility/RelationGraphClient";

export default function RelationsPage() {
  return (
    <AppShell>
      <RelationGraphClient />
    </AppShell>
  );
}
