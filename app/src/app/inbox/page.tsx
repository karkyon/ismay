import { AppShell } from "@/components/app/AppShell";
import { InboxClient } from "@/components/capture/InboxClient";

export default function InboxPage() {
  return (
    <AppShell>
      <InboxClient />
    </AppShell>
  );
}
