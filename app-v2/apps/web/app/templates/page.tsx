import { paginationRange } from "@shared/pagination";
import { AccountId } from "@packages/domain/src/ids";
import { getContainer } from "@/lib/container";
import { toTemplateDTO } from "@/lib/template-dto";
import { TemplatesTable, type TemplatesPage } from "@/components/templates/templates-table";

const PAGE_SIZE = 20;

// Same reasoning as app/contacts/page.tsx and app/broadcasts/page.tsx: the
// in-memory sql.js database lives for the life of this process, so this page
// must not be prerendered once at `next build` time.
export const dynamic = "force-dynamic";

/**
 * Server Component: reads the first, unfiltered page of templates straight
 * through `MessageTemplateRepositoryPort` (no HTTP round trip for the
 * initial paint), then hands it to the client table, which drives
 * search/status/category/pagination over `/api/templates` from there on.
 *
 * `listByAccount(accountId)` is the only method the port exposes (no
 * paginated/filtered query) — same free-tier gap `/api/templates/route.ts`
 * documents. This mirrors that route's in-memory filter-then-slice exactly
 * so the server-rendered first page and the client's own fetches agree on
 * what "page 1" means; it is not a second implementation of the filtering
 * logic, it's the same reasoning applied here because a Server Component
 * can't call its own API route.
 */
export default async function TemplatesPageRoute() {
  const { repositories, tenant } = await getContainer();
  const accountId = AccountId(tenant.tenantId);
  const all = await repositories.messageTemplates.listByAccount(accountId);

  const total = all.length;
  const pageItems = all.slice(0, PAGE_SIZE);
  const range = paginationRange(total, 1, PAGE_SIZE, pageItems.length);

  const initial: TemplatesPage = {
    items: pageItems.map(toTemplateDTO),
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
      <TemplatesTable initial={initial} />
    </main>
  );
}
