/**
 * `GET /api/conversations/unread-totals` — feeds the inbox's total-unread
 * badge.
 *
 * `totalUnread` uses `ConversationRepository.countUnreadConversations`
 * directly — the port's own doc says this mirrors the legacy
 * `useTotalUnread` definition (conversations WITH unread mail, not a sum of
 * individual unread messages) and is backed by an index, so it is exact and
 * cheap, no walk needed.
 *
 * `byConversation` has no equivalent dedicated port method (there is no
 * "list only conversations with unread_count > 0" filter on
 * `ConversationFilter`), so it walks the full keyset-paginated `list()`
 * result the same way `/api/conversations` does and keeps only the
 * unread ones. Same scale reasoning as that route's header comment: bounded
 * by conversation count for this tenant, not a real gap at this size.
 */
import { NextResponse, type NextRequest } from "next/server";
import type { ConversationListPage } from "@modules/conversations/application/ports";
import type { ConversationRecord } from "@modules/conversations/domain/conversation";
import type { SequenceCursor } from "@modules/conversations/domain/incremental-sync";
import { getContainer } from "@/lib/container";
import { internalError, ok } from "@/lib/api-response";

const WALK_CHUNK = 200;

export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const { repositories, tenant } = await getContainer();

    const totalUnread = await repositories.conversations.countUnreadConversations(tenant);

    const all: ConversationRecord[] = [];
    let cursor: SequenceCursor | undefined;
    do {
      const page: ConversationListPage = await repositories.conversations.list(
        tenant,
        {},
        { limit: WALK_CHUNK, ...(cursor !== undefined ? { before: cursor } : {}) },
      );
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    const byConversation = all
      .filter((c) => c.unreadCount > 0)
      .map((c) => ({ conversationId: c.id, unreadCount: c.unreadCount }));

    return ok({ totalUnread, byConversation });
  } catch (error) {
    return internalError(error);
  }
}
