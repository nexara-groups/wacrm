import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `seats:invite`'s minimum role is "admin" — a "manager" is below it,
 * proving both the 403 and that the gate runs before `SeatService` (and
 * therefore the seat repository and the invite email) is ever reached.
 */
const TENANT_ID = "11111111-1111-1111-8111-111111111111";

let sessionUser: { userId: string; tenantId: string; role: string } = {
  userId: "u1",
  tenantId: TENANT_ID,
  role: "manager",
};

const repositories = {
  seats: {
    listInvitations: vi.fn(async () => []),
    reserveSeatAndCreateInvitation: vi.fn(async () => null),
  },
};

vi.mock("@/lib/container", () => ({
  getContainer: async () => ({
    repositories,
    tenant: { tenantId: TENANT_ID },
    ownerUserId: "u1",
    emailProvider: { send: vi.fn(async () => {}) },
  }),
}));
vi.mock("@/lib/session", () => ({
  getCurrentAuth: async () => ({ user: sessionUser, tenant: { tenantId: TENANT_ID }, accessToken: "t" }),
}));

const { POST } = await import("./route");

function post(body: unknown): Request {
  return new Request("https://example.test/api/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "manager" };
  repositories.seats.listInvitations.mockClear();
  repositories.seats.reserveSeatAndCreateInvitation.mockClear();
});

describe("POST /api/invitations", () => {
  it("refuses a manager (below the admin minimum) and writes nothing", async () => {
    const res = await POST(post({ email: "new@example.test", role: "member" }) as never);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("forbidden");
    expect(repositories.seats.reserveSeatAndCreateInvitation).not.toHaveBeenCalled();
  });
});
