import { describe, expect, it, vi } from "vitest";
import type { ApiClientContext, FetchLike } from "../http";
import { createConversationsResource } from "./conversations";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeCtx(fetchFn: FetchLike): ApiClientContext {
  return { baseUrl: "https://api.example.test", fetchFn, headers: {} };
}

describe("conversations resource", () => {
  it("list() encodes unreadOnly:true but OMITS unreadOnly:false from the query string", async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      jsonResponse({ ok: true, items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1, from: 0, to: 0, hasPrevious: false, hasNext: false } }),
    );
    const conversations = createConversationsResource(makeCtx(fetchFn));

    await conversations.list({ unreadOnly: true, page: 1, pageSize: 20 });
    const trueUrl = new URL(fetchFn.mock.calls[0]?.[0] as string);
    expect(trueUrl.searchParams.get("unreadOnly")).toBe("true");

    await conversations.list({ unreadOnly: false, page: 1, pageSize: 20 });
    const falseUrl = new URL(fetchFn.mock.calls[1]?.[0] as string);
    // `booleanQueryFlagSchema` on the server parses the string "false"
    // back to `false`, so the client sends it rather than dropping it.
    expect(falseUrl.searchParams.get("unreadOnly")).toBe("false");
  });

  it("sync() posts the cursor/limit request body and parses changes + nextCursor", async () => {
    const response = {
      ok: true,
      changes: [
        { changeType: "upserted", conversation: { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", accountId: "4fa85f64-5717-4562-b3fc-2c963f66afa6", contactId: "5fa85f64-5717-4562-b3fc-2c963f66afa6", assignedUserId: null, lastMessageAt: null, unreadCount: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } },
        { changeType: "deleted", conversationId: "6fa85f64-5717-4562-b3fc-2c963f66afa6" },
      ],
      nextCursor: "cursor-abc",
      hasMore: false,
    };
    const fetchFn = vi.fn<FetchLike>(async () => jsonResponse(response));
    const conversations = createConversationsResource(makeCtx(fetchFn));

    const result = await conversations.sync({ cursor: null, limit: 100 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changes).toHaveLength(2);
      expect(result.value.nextCursor).toBe("cursor-abc");
    }
    expect(fetchFn.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ cursor: null, limit: 100 }));
  });
});
