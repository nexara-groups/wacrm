import { paginationRange } from "@shared/pagination";
import type { AccountId } from "@packages/domain/src/ids";
import type { BroadcastRecord } from "@modules/broadcasts/application/ports";
import { getContainer } from "@/lib/container";
import { toBroadcastDTO } from "@/lib/broadcast-dto";
import { BroadcastsTable, type BroadcastsPage } from "@/components/broadcasts/broadcasts-table";

const PAGE_SIZE = 20;

// Same reasoning as app/contacts/page.tsx: the in-memory sql.js database
// lives for the life of this process, so this page must not be prerendered
// once at build time.
export const dynamic = "force-dynamic";

/**
 * Server Component: reads the first page of broadcasts straight through
 * `BroadcastRepositoryPort` (no HTTP round trip for the initial paint), then
 * hands it to the client table, which drives search/status/pagination over
 * `/api/broadcasts` from there on.
 *
 * `BroadcastRepositoryPort.listForAccount` is cursor-only with no total
 * count (see /api/broadcasts/route.ts's docstring for the full gap) — this
 * page walks every cursor page once, exactly like that route does, so the
 * server-rendered first page and the client's own fetches agree on what
 * "page 1 of N" means.
 */
export default async function BroadcastsPageRoute() {
  const { repositories, tenant } = await getContainer();
  const accountId = tenant.tenantId as AccountId;

  const all: BroadcastRecord[] = [];
  let cursor: string | null = null;
  do {
    const page = await repositories.broadcasts.listForAccount(accountId, cursor, 200);
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);

  all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const total = all.length;
  const pageItems = all.slice(0, PAGE_SIZE);
  const range = paginationRange(total, 1, PAGE_SIZE, pageItems.length);

  const initial: BroadcastsPage = {
    items: pageItems.map(toBroadcastDTO),
    pagination: {
      page: 1,
      pageSize: PAGE_SIZE,
      total,
      totalPages: range.totalPages,
      from: range.from,
      to: range.to,
      hasPrevious: range.hasPrevious,
      hasNext: range.hasNext,
    },
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <BroadcastsTable initial={initial} />
    </main>
  );
}
