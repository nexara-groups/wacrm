/**
 * `/api/conversations` — list (filter + paginate) for the inbox left pane.
 *
 * Same discipline as `/api/contacts` and `/api/broadcasts`: every request is
 * validated against `listConversationsQuerySchema`
 * (`@packages/contracts/src/conversations`) before touching a repository,
 * and every failure goes out through the shared error envelope.
 *
 * This calls `ConversationRepository.search` directly: status,
 * assignedUserId (including the contract's explicit `"unassigned"`
 * literal), unreadOnly and search are all filtered in SQL, and the total is
 * a real `COUNT(*)` — a single bounded read, never a walk of the whole
 * keyset-paginated `list()` result. See `ports.ts`'s `ConversationSearchFilter`
 * / `search()` docs for the SQL side.
 */
import { NextResponse, type NextRequest } from "next/server";
import { listConversationsQuerySchema } from "@packages/contracts/src/conversations";
import { paginationRange } from "@shared/pagination";
import type { ConversationSearchFilter } from "@modules/conversations/application/ports";
import { getContainer } from "@/lib/container";
import { toConversationDTO } from "@/lib/conversation-dto";
import {
  internalError,
  isZodError,
  ok,
  parseOrThrow,
  validationError,
} from "@/lib/api-response";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(listConversationsQuerySchema, {
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      assignedUserId: searchParams.get("assignedUserId") ?? undefined,
      unreadOnly: searchParams.get("unreadOnly") ?? undefined,
      search: searchParams.get("search") ?? undefined,
    });

    const { repositories, tenant } = await getContainer();

    const filter: ConversationSearchFilter = {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.assignedUserId !== undefined
        ? { assignedUserId: query.assignedUserId === "unassigned" ? null : query.assignedUserId }
        : {}),
      ...(query.unreadOnly !== undefined ? { unreadOnly: query.unreadOnly } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
    };

    const { items, total } = await repositories.conversations.search(tenant, filter, {
      page: query.page,
      pageSize: query.pageSize,
    });

    const range = paginationRange(total, query.page, query.pageSize, items.length);

    return ok({
      items: items.map(toConversationDTO),
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
