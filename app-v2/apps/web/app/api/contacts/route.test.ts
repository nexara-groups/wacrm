import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `contacts:write`'s minimum role is "member", the lowest rank in the
 * system (see `lib/route-authorization.ts`) — every real tenant role
 * clears it, so there is no in-tenant role to prove a 403 against. What
 * this proves instead is that the gate runs BEFORE the repository is
 * touched: an unauthenticated caller is refused without ever reaching
 * `contacts.findByPhone`/`.create`.
 */
const TENANT_ID = "11111111-1111-1111-8111-111111111111";

let sessionUser: { userId: string; tenantId: string; role: string } | null = {
  userId: "u1",
  tenantId: TENANT_ID,
  role: "member",
};

const repositories = {
  contacts: {
    findByPhone: vi.fn(async () => null),
    create: vi.fn(async () => ({})),
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

function post(body: unknown): Request {
  return new Request("https://example.test/api/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "member" };
  repositories.contacts.findByPhone.mockClear();
  repositories.contacts.create.mockClear();
});

describe("POST /api/contacts", () => {
  it("refuses an unauthenticated caller and writes nothing", async () => {
    sessionUser = null;
    const res = await POST(post({ phoneNumber: "+15551234567" }) as never);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("unauthenticated");
    expect(repositories.contacts.findByPhone).not.toHaveBeenCalled();
    expect(repositories.contacts.create).not.toHaveBeenCalled();
  });
});
