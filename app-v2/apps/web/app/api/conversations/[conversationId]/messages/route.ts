/**
 * `GET /api/conversations/[conversationId]/messages` — a thread page for
 * the inbox right pane.
 *
 * Calls `MessageRepository.listThreadPage` directly: `COUNT(*)` +
 * `LIMIT`/`OFFSET` in SQL, so this is a single bounded read — never a walk
 * of the whole thread to bridge page/cursor semantics. `listThread`
 * (keyset) stays available for callers that want that shape (incremental
 * screens); this is the one for "give me page N of M."
 *
 * Ordering: `listThreadPage` returns newest-first (`created_at desc, id
 * desc`) and this route preserves that — `page=1` is the most recent slice
 * of the conversation, `page=2` the next-older slice, and so on. The inbox
 * screen renders `items` in that same order (newest at the top of the pane,
 * oldest at the bottom), per the task brief's "oldest at the bottom."
 */
import { NextResponse, type NextRequest } from "next/server";
import { getThreadQuerySchema } from "@packages/contracts/src/conversations";
import { paginationRange } from "@shared/pagination";
import { getContainer } from "@/lib/container";
import { toConversationDTO } from "@/lib/conversation-dto";
import { toMessageDTO } from "@/lib/message-dto";
import {
  internalError,
  isZodError,
  notFoundError,
  ok,
  parseOrThrow,
  validationError,
} from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { conversationId: raw } = await context.params;
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(getThreadQuerySchema, {
      conversationId: raw,
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
    });

    const { repositories, tenant } = await getContainer();
    const conversation = await repositories.conversations.findById(tenant, query.conversationId);
    if (conversation === null) return notFoundError("conversation");

    const { items, total } = await repositories.messages.listThreadPage(tenant, query.conversationId, {
      page: query.page,
      pageSize: query.pageSize,
    });

    const range = paginationRange(total, query.page, query.pageSize, items.length);

    return ok({
      conversation: toConversationDTO(conversation),
      items: items.map(toMessageDTO),
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
