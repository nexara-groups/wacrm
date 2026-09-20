import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `conversations:assign`'s minimum role is "manager" — a "member" is below
 * it, so this proves both that a member gets 403 and that the gate runs
 * before the repository is touched.
 */
const TENANT_ID = "11111111-1111-1111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-8222-222222222222";

let sessionUser: { userId: string; tenantId: string; role: string } = {
  userId: "u1",
  tenantId: TENANT_ID,
  role: "member",
};

const repositories = {
  users: {
    findById: vi.fn(async () => null),
  },
  conversations: {
    findById: vi.fn(async () => null),
    save: vi.fn(async (_tenant: unknown, next: unknown) => next),
  },
};

vi.mock("@/lib/container", () => ({
  getContainer: async () => ({ repositories, tenant: { tenantId: TENANT_ID } }),
}));
vi.mock("@/lib/session", () => ({
  getCurrentAuth: async () => ({ user: sessionUser, tenant: { tenantId: TENANT_ID }, accessToken: "t" }),
}));

const { POST } = await import("./route");

function post(body: unknown): Request {
  return new Request(`https://example.test/api/conversations/${CONVERSATION_ID}/assign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx() {
  return { params: Promise.resolve({ conversationId: CONVERSATION_ID }) };
}

beforeEach(() => {
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "member" };
  repositories.users.findById.mockClear();
  repositories.conversations.findById.mockClear();
  repositories.conversations.save.mockClear();
});

describe("POST /api/conversations/[conversationId]/assign", () => {
  it("refuses a member (below the manager minimum) and writes nothing", async () => {
    const res = await POST(post({ assignedUserId: null }) as never, ctx() as never);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("forbidden");
    expect(repositories.users.findById).not.toHaveBeenCalled();
    expect(repositories.conversations.findById).not.toHaveBeenCalled();
    expect(repositories.conversations.save).not.toHaveBeenCalled();
  });
});
