import { notFound } from "next/navigation";
import { broadcastIdSchema } from "@packages/contracts/src/common/ids";
import type { AccountId } from "@packages/domain/src/ids";
import type { BroadcastRecipient } from "@packages/domain/src/entities/broadcast-recipient";
import { getContainer } from "@/lib/container";
import { toBroadcastDTO, toBroadcastReportDTO } from "@/lib/broadcast-dto";
import { BroadcastDetail } from "@/components/broadcasts/broadcast-detail";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ broadcastId: string }>;
}

/**
 * Server Component: reads the broadcast, its full recipient report, and its
 * template's name straight through the repositories for first paint — the
 * pause/resume/cancel/schedule controls then drive the `/api/broadcasts/
 * [broadcastId]/*` routes client-side and call `router.refresh()` to pull
 * fresh server data back in, the same pattern `/broadcasts` uses for
 * search.
 */
export default async function BroadcastDetailPage({ params }: PageProps) {
  const { broadcastId: raw } = await params;
  const parsed = broadcastIdSchema.safeParse(raw);
  if (!parsed.success) notFound();
  const broadcastId = parsed.data;

  const { repositories, tenant } = await getContainer();
  const accountId = tenant.tenantId as AccountId;

  const broadcast = await repositories.broadcasts.getById(accountId, broadcastId);
  if (broadcast === null) notFound();

  const rows: BroadcastRecipient[] = [];
  let cursor: string | null = null;
  do {
    const page = await repositories.broadcastRecipients.listByBroadcast(accountId, broadcastId, cursor, 200);
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);

  const template = await repositories.messageTemplates.findById(accountId, broadcast.templateId);

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <BroadcastDetail
        broadcast={toBroadcastDTO(broadcast)}
        report={toBroadcastReportDTO(broadcast, rows)}
        templateName={template?.name ?? null}
      />
    </main>
  );
}
