import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `conversations:mark-read`'s minimum role is "member", the lowest rank in
 * the system — every real tenant role clears it, so there is no in-tenant
 * role to prove a 403 against. This proves the gate runs before the
 * repository is touched: an unauthenticated caller never reaches
 * `conversations.findById`/`.save`.
 */
const TENANT_ID = "11111111-1111-1111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-8222-222222222222";

let sessionUser: { userId: string; tenantId: string; role: string } | null = {
  userId: "u1",
  tenantId: TENANT_ID,
  role: "member",
};

const repositories = {
  conversations: {
    findById: vi.fn(async () => null),
    save: vi.fn(async (_tenant: unknown, next: unknown) => next),
  },
};

vi.mock("@/lib/container", () => ({
  getContainer: async () => ({ repositories, tenant: { tenantId: TENANT_ID } }),
}));
vi.mock("@/lib/session", () => ({
  getCurrentAuth: async () =>
    sessionUser ? { user: sessionUser, tenant: { tenantId: TENANT_ID }, accessToken: "t" } : null,
}));

const { POST } = await import("./route");

function post(): Request {
  return new Request(`https://example.test/api/conversations/${CONVERSATION_ID}/read`, { method: "POST" });
}

function ctx() {
  return { params: Promise.resolve({ conversationId: CONVERSATION_ID }) };
}

beforeEach(() => {
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "member" };
  repositories.conversations.findById.mockClear();
  repositories.conversations.save.mockClear();
});

describe("POST /api/conversations/[conversationId]/read", () => {
  it("refuses an unauthenticated caller and writes nothing", async () => {
    sessionUser = null;
    const res = await POST(post() as never, ctx() as never);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("unauthenticated");
    expect(repositories.conversations.findById).not.toHaveBeenCalled();
    expect(repositories.conversations.save).not.toHaveBeenCalled();
  });
});
