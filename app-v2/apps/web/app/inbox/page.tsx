import { getContainer } from "@/lib/container";
import { toContactDTO } from "@/lib/contact-dto";
import { InboxView } from "@/components/inbox/inbox-view";

// Same reasoning as app/contacts/page.tsx: the in-memory sql.js database
// lives for the life of this process, so this page must not be prerendered
// once at build time.
export const dynamic = "force-dynamic";

/**
 * Server Component shell for `/inbox`.
 *
 * Unlike `app/contacts/page.tsx`, this does NOT prefetch the first page of
 * conversations through the repository directly. `ConversationRepository
 * .list` has no total count (see `/api/conversations`'s header comment for
 * the full page/cursor writeup) — computing an accurate initial page here
 * would mean either duplicating that route's walk-and-slice logic in a
 * second place (a real drift risk) or shipping a dishonest placeholder
 * total. Instead `InboxView` fetches `/api/conversations` itself on mount,
 * the same single source of truth the route already guarantees is correct.
 *
 * What IS fetched here, straight through `ContactRepository` (no HTTP round
 * trip): every contact for this tenant, to resolve `contactId` -> name/phone
 * for the list and thread header — `Conversation`/`Message` on the wire
 * carry only `contactId`, no denormalized contact fields (see
 * `lib/conversation-dto.ts`).
 */
export default async function InboxPageRoute() {
  const { repositories, tenant, ownerUserId } = await getContainer();
  const contacts = await repositories.contacts.listAll(tenant);

  return (
    <main className="mx-auto flex h-[calc(100vh-4rem)] max-w-6xl flex-col px-4 py-6">
      <InboxView contacts={contacts.map(toContactDTO)} ownerUserId={ownerUserId} />
    </main>
  );
}
