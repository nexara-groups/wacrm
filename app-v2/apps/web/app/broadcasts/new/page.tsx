import { templateSchema } from "@packages/contracts/src/templates";
import type { AccountId } from "@packages/domain/src/ids";
import { getContainer } from "@/lib/container";
import { BroadcastComposer } from "@/components/broadcasts/broadcast-composer";

export const dynamic = "force-dynamic";

/**
 * Server Component: reads message templates straight through
 * `MessageTemplateRepositoryPort` for first paint (the composer's template
 * picker never needs to be live-searched the way contacts/broadcasts do, so
 * unlike those screens there is no dedicated `/api/templates` route in this
 * slice — see the build brief's file list).
 *
 * `WhatsAppTemplateRecord` (the port's record type) is a strict superset of
 * the wire `templateSchema` (it adds `metaTemplateId`/`components`, both
 * Meta-vendor concerns `packages/contracts` deliberately excludes) —
 * `templateSchema.parse` strips those extra fields the same way
 * `toContactDTO`/`toBroadcastDTO` map a record onto its wire shape
 * elsewhere in this app.
 */
export default async function NewBroadcastPage() {
  const { repositories, tenant } = await getContainer();
  const accountId = tenant.tenantId as AccountId;

  const templates = await repositories.messageTemplates.listByAccount(accountId);
  const templateDTOs = templates.map((template) => templateSchema.parse(template));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <BroadcastComposer templates={templateDTOs} />
    </main>
  );
}
