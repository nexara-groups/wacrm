/**
 * `/api/conversations` — list (filter + paginate) for the inbox left pane.
 *
 * Same discipline as `/api/contacts` and `/api/broadcasts`: every request is
 * validated against `listConversationsQuerySchema`
 * (`@packages/contracts/src/conversations`) before touching a repository,
 * and every failure goes out through the shared error envelope.
 *
 * -----------------------------------------------------------------------
 * THE page/pageSize <-> CURSOR TENSION — and how this route resolves it
 * -----------------------------------------------------------------------
 * `listConversationsQuerySchema` extends `paginationQuerySchema`
 * (page/pageSize, per the task brief this is required to honor), but
 * `ConversationRepository.list` (modules/conversations/application/ports.ts)
 * is keyset-paginated by a `SequenceCursor` — `{ limit, before? }` — with NO
 * page number and NO total count. The two genuinely do not agree, and
 * per this task's hard rules the port may not grow a new method and no SQL
 * may be written here to bridge them.
 *
 * Resolution taken (identical in shape to `/api/broadcasts`'s own
 * page/cursor mismatch, documented in that route): this handler walks the
 * ENTIRE keyset-paginated result for this tenant+filter (internal chunks of
 * `WALK_CHUNK`, following `nextCursor` until it is `null`), applies the
 * filters the port itself does not support in-memory, and only THEN slices
 * by `page`/`pageSize` and computes a real `total`. This keeps the wire
 * contract honest — a client asking for page 2 of 20 gets an actual page 2
 * of an actual total, never a leaked opaque cursor — at the cost of
 * re-walking the full set on every request. That is fine at this slice's
 * scale (one tenant's own inbox; conversations are created one per contact,
 * never per-message, so this is bounded by contact count, not message
 * volume) but would need a real port change (a native count + offset, or a
 * page-shaped list method) if a tenant's conversation count ever grew large
 * enough for that to matter. Documented here rather than silently accepted.
 *
 * A second, smaller gap in the same area: `ConversationFilter.assignedUserId`
 * (the port) accepts `undefined | null | string` — `null` means "unassigned
 * only" — but `listConversationsQuerySchema.assignedUserId` is
 * `userIdSchema.optional()`, which can only express "a concrete user" or
 * "absent." There is no way to ask this validated endpoint for "unassigned
 * only" at all. Inventing an out-of-contract query value would violate rule
 * 3 (validate against the real contract), so this route does not attempt
 * it: the "assigned to me / unassigned / all" toggle the inbox screen wants
 * is applied CLIENT-SIDE over the unfiltered (or specific-assignee-filtered)
 * page instead — see `components/inbox/conversation-list.tsx`. A real fix
 * is a contract change (e.g. `assignedUserId: userIdSchema.nullable()
 * .optional()`), out of scope here since `packages/**` may not be modified.
 *
 * `unreadOnly` and `search` are also not expressible in
 * `ConversationFilter` (it only has `status`, `assignedUserId`,
 * `contactId`), so both are applied in-memory after the walk above.
 * `search` additionally needs the contact's name/phone — `Conversation`
 * (the wire shape) carries only `contactId`, no denormalized contact
 * fields — so this route joins against `repositories.contacts.listAll`
 * (only when `search` is actually supplied) purely to filter; the response
 * itself still only ever carries `contactId`, per contract.
 */
import { NextResponse, type NextRequest } from "next/server";
import { listConversationsQuerySchema } from "@packages/contracts/src/conversations";
import { paginationRange } from "@shared/pagination";
import type { ConversationFilter, ConversationListPage } from "@modules/conversations/application/ports";
import type { ConversationRecord } from "@modules/conversations/domain/conversation";
import type { SequenceCursor } from "@modules/conversations/domain/incremental-sync";
import { getContainer } from "@/lib/container";
import { toConversationDTO } from "@/lib/conversation-dto";
import {
  internalError,
  isZodError,
  ok,
  parseOrThrow,
  validationError,
} from "@/lib/api-response";

/** Internal page size for walking the keyset — not the client-facing `pageSize`. */
const WALK_CHUNK = 200;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(listConversationsQuerySchema, {
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
      assignedUserId: searchParams.get("assignedUserId") ?? undefined,
      unreadOnly: searchParams.get("unreadOnly") ?? undefined,
      search: searchParams.get("search") ?? undefined,
    });

    const { repositories, tenant } = await getContainer();

    const filter: ConversationFilter = {
      ...(query.assignedUserId !== undefined ? { assignedUserId: query.assignedUserId } : {}),
    };

    const all: ConversationRecord[] = [];
    let cursor: SequenceCursor | undefined;
    do {
      const page: ConversationListPage = await repositories.conversations.list(tenant, filter, {
        limit: WALK_CHUNK,
        ...(cursor !== undefined ? { before: cursor } : {}),
      });
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    let filtered = query.unreadOnly === true ? all.filter((c) => c.unreadCount > 0) : all;

    if (query.search !== undefined) {
      const needle = query.search.trim().toLowerCase();
      const contacts = await repositories.contacts.listAll(tenant);
      const contactById = new Map(contacts.map((c) => [c.id, c] as const));
      filtered = filtered.filter((conversation) => {
        const contact = contactById.get(conversation.contactId);
        if (!contact) return false;
        const name = (contact.displayName ?? "").toLowerCase();
        const phone = contact.phoneNumber.toLowerCase();
        return name.includes(needle) || phone.includes(needle);
      });
    }

    // Already newest-`lastMessageAt`-first from the port; filtering above
    // preserves that order.
    const total = filtered.length;
    const start = (query.page - 1) * query.pageSize;
    const pageItems = filtered.slice(start, start + query.pageSize);
    const range = paginationRange(total, query.page, query.pageSize, pageItems.length);

    return ok({
      items: pageItems.map(toConversationDTO),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: range.totalPages,
        from: range.from,
        to: range.to,
        hasPrevious: range.hasPrevious,
        hasNext: range.hasNext,
      },
    });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
