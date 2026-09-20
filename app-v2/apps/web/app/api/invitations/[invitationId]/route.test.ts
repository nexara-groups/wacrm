import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `invitations:revoke`'s minimum role is "admin" — a "manager" is below
 * it, proving both the 403 and that the gate runs before the seats
 * repository is ever touched.
 */
const TENANT_ID = "11111111-1111-1111-8111-111111111111";
const INVITATION_ID = "inv-1";

let sessionUser: { userId: string; tenantId: string; role: string } = {
  userId: "u1",
  tenantId: TENANT_ID,
  role: "manager",
};

const repositories = {
  seats: {
    listInvitations: vi.fn(async () => []),
    markInvitationExpiredOrRevoked: vi.fn(async () => {}),
  },
};

vi.mock("@/lib/container", () => ({
  getContainer: async () => ({ repositories, tenant: { tenantId: TENANT_ID } }),
}));
vi.mock("@/lib/session", () => ({
  getCurrentAuth: async () => ({ user: sessionUser, tenant: { tenantId: TENANT_ID }, accessToken: "t" }),
}));

const { DELETE } = await import("./route");

function del(): Request {
  return new Request(`https://example.test/api/invitations/${INVITATION_ID}`, { method: "DELETE" });
}

function ctx() {
  return { params: Promise.resolve({ invitationId: INVITATION_ID }) };
}

beforeEach(() => {
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "manager" };
  repositories.seats.listInvitations.mockClear();
  repositories.seats.markInvitationExpiredOrRevoked.mockClear();
});

describe("DELETE /api/invitations/[invitationId]", () => {
  it("refuses a manager (below the admin minimum) and writes nothing", async () => {
    const res = await DELETE(del() as never, ctx() as never);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("forbidden");
    expect(repositories.seats.listInvitations).not.toHaveBeenCalled();
    expect(repositories.seats.markInvitationExpiredOrRevoked).not.toHaveBeenCalled();
  });
});
