import { WhatsappConnectionScreen } from "@/components/settings/whatsapp-connection-screen";

/**
 * Unlike `app/settings/team/page.tsx` and `app/templates/page.tsx`, this
 * page does no direct repository read for an initial paint: the mapping
 * from `WhatsAppConfigRecord` to the wire `WhatsappConnection` (stripping
 * the access token, gating the write on `tenant:manage`) is
 * `app/api/whatsapp/connection/route.ts`'s job, and re-deciding tenant
 * visibility here a second time is exactly the drift this file should not
 * risk. The screen fetches that route itself on mount.
 */
export default function WhatsappSettingsPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <WhatsappConnectionScreen />
    </main>
  );
}
