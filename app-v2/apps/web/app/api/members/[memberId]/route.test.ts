import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Both writes here have an "admin" minimum, so a "manager" is below either,
 * proving the 403 and that the gate runs before the seats repository or
 * `SeatService` is ever touched.
 *
 * PATCH matters as much as DELETE: reactivating a member consumes a seat,
 * which is the same spend an invitation makes. It was missing from the first
 * version of `ACTION_MINIMUM_ROLE` and shipped ungated for one commit.
 */
const TENANT_ID = "11111111-1111-1111-8111-111111111111";
const MEMBER_ID = "member-1";

let sessionUser: { userId: string; tenantId: string; role: string } = {
  userId: "u1",
  tenantId: TENANT_ID,
  role: "manager",
};

const repositories = {
  seats: {
    listMembers: vi.fn(async () => []),
    removeMemberAndRecompute: vi.fn(async () => {}),
  },
};

vi.mock("@/lib/container", () => ({
  getContainer: async () => ({ repositories, tenant: { tenantId: TENANT_ID } }),
}));
vi.mock("@/lib/session", () => ({
  getCurrentAuth: async () => ({ user: sessionUser, tenant: { tenantId: TENANT_ID }, accessToken: "t" }),
}));

const { DELETE, PATCH } = await import("./route");

function del(): Request {
  return new Request(`https://example.test/api/members/${MEMBER_ID}`, { method: "DELETE" });
}

function ctx() {
  return { params: Promise.resolve({ memberId: MEMBER_ID }) };
}

beforeEach(() => {
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "manager" };
  repositories.seats.listMembers.mockClear();
  repositories.seats.removeMemberAndRecompute.mockClear();
});

describe("DELETE /api/members/[memberId]", () => {
  it("refuses a manager (below the admin minimum) and writes nothing", async () => {
    const res = await DELETE(del() as never, ctx() as never);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("forbidden");
    expect(repositories.seats.listMembers).not.toHaveBeenCalled();
    expect(repositories.seats.removeMemberAndRecompute).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/members/[memberId] — reactivation", () => {
  it("refuses a manager (below the admin minimum) and writes nothing", async () => {
    const res = await PATCH(new Request(`https://example.test/api/members/${MEMBER_ID}`, { method: "PATCH" }) as never, ctx() as never);

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    // The gate runs before the member is even looked up.
    expect(repositories.seats.listMembers).not.toHaveBeenCalled();
  });
});
