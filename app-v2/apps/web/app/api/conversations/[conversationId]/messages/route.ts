/**
 * `GET /api/conversations/[conversationId]/messages` — a thread page for
 * the inbox right pane.
 *
 * Same page/pageSize <-> cursor tension as `/api/conversations` (see that
 * route's header for the full writeup) — `getThreadQuerySchema` extends
 * `paginationQuerySchema`, but `MessageRepository.listThread` is
 * keyset-paginated (`{ limit, before? }`, newest-first, no total count) and
 * may not grow a new method. Resolved the same way: this route walks the
 * FULL thread for this conversation in `WALK_CHUNK` hops, then slices by
 * `page`/`pageSize` and computes a real `total`. Threads are one contact's
 * message history, not a whole tenant's message volume, so re-walking a
 * single thread per request is bounded and acceptable at this slice's
 * scale — the seed data includes one long thread specifically so this
 * pagination is exercised for real, not just in theory.
 *
 * Ordering: `listThread` returns newest-first (`created_at desc, id desc`)
 * and this route preserves that — `page=1` is the most recent slice of the
 * conversation, `page=2` the next-older slice, and so on, matching the
 * port's own "next OLDER page" framing. The inbox screen renders `items` in
 * that same order (newest at the top of the pane, oldest at the bottom),
 * per the task brief's "oldest at the bottom."
 */
import { NextResponse, type NextRequest } from "next/server";
import { getThreadQuerySchema } from "@packages/contracts/src/conversations";
import { paginationRange } from "@shared/pagination";
import type { ThreadPage } from "@modules/conversations/application/ports";
import type { MessageRecord } from "@modules/conversations/domain/message";
import type { SequenceCursor } from "@modules/conversations/domain/incremental-sync";
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

const WALK_CHUNK = 200;

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

    const all: MessageRecord[] = [];
    let cursor: SequenceCursor | undefined;
    do {
      const page: ThreadPage = await repositories.messages.listThread(tenant, query.conversationId, {
        limit: WALK_CHUNK,
        ...(cursor !== undefined ? { before: cursor } : {}),
      });
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    const total = all.length;
    const start = (query.page - 1) * query.pageSize;
    const pageItems = all.slice(start, start + query.pageSize);
    const range = paginationRange(total, query.page, query.pageSize, pageItems.length);

    return ok({
      conversation: toConversationDTO(conversation),
      items: pageItems.map(toMessageDTO),
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
