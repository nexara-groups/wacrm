import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `contacts:write`'s minimum role is "member", the lowest rank in the
 * system — every real tenant role clears it, so there is no in-tenant role
 * to prove a 403 against. This proves the gate runs before the repository
 * is touched: an unauthenticated caller never reaches `updateProfile`.
 */
const TENANT_ID = "11111111-1111-1111-8111-111111111111";
const CONTACT_ID = "22222222-2222-2222-8222-222222222222";

let sessionUser: { userId: string; tenantId: string; role: string } | null = {
  userId: "u1",
  tenantId: TENANT_ID,
  role: "member",
};

const repositories = {
  contacts: {
    updateProfile: vi.fn(async () => ({})),
  },
};

vi.mock("@/lib/container", () => ({
  getContainer: async () => ({ repositories, tenant: { tenantId: TENANT_ID } }),
}));
vi.mock("@/lib/session", () => ({
  getCurrentAuth: async () =>
    sessionUser ? { user: sessionUser, tenant: { tenantId: TENANT_ID }, accessToken: "t" } : null,
}));

const { PATCH } = await import("./route");

function patch(body: unknown): Request {
  return new Request(`https://example.test/api/contacts/${CONTACT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx() {
  return { params: Promise.resolve({ contactId: CONTACT_ID }) };
}

beforeEach(() => {
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "member" };
  repositories.contacts.updateProfile.mockClear();
});

describe("PATCH /api/contacts/[contactId]", () => {
  it("refuses an unauthenticated caller and writes nothing", async () => {
    sessionUser = null;
    const res = await PATCH(patch({ contactId: CONTACT_ID, displayName: "Amy" }) as never, ctx() as never);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("unauthenticated");
    expect(repositories.contacts.updateProfile).not.toHaveBeenCalled();
  });
});
