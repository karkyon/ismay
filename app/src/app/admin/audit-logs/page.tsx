import { AppShell } from "@/components/app/AppShell";
import { AuditLogsClient } from "@/components/admin/AuditLogsClient";

export default function AuditLogsPage() {
  return (
    <AppShell>
      <AuditLogsClient />
    </AppShell>
  );
}
