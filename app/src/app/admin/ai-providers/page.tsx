import { AppShell } from "@/components/app/AppShell";
import { AiProvidersAdminClient } from "@/components/admin/AiProvidersAdminClient";

export default function AiProvidersAdminPage() {
  return (
    <AppShell>
      <AiProvidersAdminClient />
    </AppShell>
  );
}
