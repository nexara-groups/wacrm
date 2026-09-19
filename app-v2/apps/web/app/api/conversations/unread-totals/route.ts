/**
 * `GET /api/conversations/unread-totals` — the unread badge data.
 *
 * `totalUnread` is a single `COUNT(*)` via
 * `ConversationRepository.countUnreadConversations`, backed by the
 * `(account_id, unread_count)` index.
 *
 * `byConversation` is a BOUNDED page of unread conversations, not all of
 * them. This route used to walk the entire keyset result in 200-row chunks
 * and filter in memory, which meant the badge on every inbox load cost one
 * row read per conversation in the account — on D1's free tier, where rows
 * read are metered, that made the cheapest UI element the most expensive
 * query, and it grew with the customer's history rather than their traffic.
 *
 * The cap is a deliberate product call, not a shortcut: per-conversation
 * unread counts exist to decorate rows the user can actually see, and
 * nobody reads a list of ten thousand badges. `totalUnread` stays exact —
 * it comes from the COUNT, not from this array's length — so the headline
 * number is never capped even when the detail is.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getContainer } from "@/lib/container";
import { internalError, ok } from "@/lib/api-response";

/** Enough to decorate any plausible inbox page; far below a full-table read. */
const MAX_BADGES = 200;

export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const { repositories, tenant } = await getContainer();

    const totalUnread = await repositories.conversations.countUnreadConversations(tenant);

    const unread = await repositories.conversations.search(
      tenant,
      { unreadOnly: true },
      { page: 1, pageSize: MAX_BADGES },
    );

    return ok({
      totalUnread,
      byConversation: unread.items.map((c) => ({
        conversationId: c.id,
        unreadCount: c.unreadCount,
      })),
    });
  } catch (error) {
    return internalError(error);
  }
}
