import { paginationRange } from "@shared/pagination";
import { getContainer } from "@/lib/container";
import { toContactDTO } from "@/lib/contact-dto";
import { ContactsTable, type ContactsPage } from "@/components/contacts/contacts-table";

const PAGE_SIZE = 20;

// The in-memory sql.js database lives for the life of this process (see
// lib/container.ts). Without this, Next would prerender this page once at
// `next build` time and keep serving that static snapshot from `next
// start` — out of sync with the live container the API routes (dynamic by
// nature) read from on every request.
export const dynamic = "force-dynamic";

/**
 * Server Component: reads the first page of contacts straight through the
 * real `ContactRepository` (no HTTP round trip for the initial paint), then
 * hands it to the client table, which drives search/pagination over
 * `/api/contacts` from there on.
 */
export default async function ContactsPageRoute() {
  const { repositories, tenant } = await getContainer();
  const result = await repositories.contacts.search(tenant, {}, { page: 1, pageSize: PAGE_SIZE });
  const range = paginationRange(result.total, 1, PAGE_SIZE, result.items.length);

  const initial: ContactsPage = {
    items: result.items.map(toContactDTO),
    pagination: {
      page: 1,
      pageSize: PAGE_SIZE,
      total: result.total,
      totalPages: range.totalPages,
      from: range.from,
      to: range.to,
      hasPrevious: range.hasPrevious,
      hasNext: range.hasNext,
    },
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <ContactsTable initial={initial} />
    </main>
  );
}
