import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `broadcasts:control`'s minimum role is "manager" — a "member" is below
 * it, proving both the 403 and that the gate runs before the repository is
 * touched.
 */
const TENANT_ID = "11111111-1111-1111-8111-111111111111";
const BROADCAST_ID = "22222222-2222-2222-8222-222222222222";

let sessionUser: { userId: string; tenantId: string; role: string } = {
  userId: "u1",
  tenantId: TENANT_ID,
  role: "member",
};

const repositories = {
  broadcasts: {
    getById: vi.fn(async () => null),
    setPaused: vi.fn(async () => {}),
  },
};

vi.mock("@/lib/container", () => ({
  getContainer: async () => ({ repositories, tenant: { tenantId: TENANT_ID } }),
}));
vi.mock("@/lib/session", () => ({
  getCurrentAuth: async () => ({ user: sessionUser, tenant: { tenantId: TENANT_ID }, accessToken: "t" }),
}));

const { POST } = await import("./route");

function post(): Request {
  return new Request(`https://example.test/api/broadcasts/${BROADCAST_ID}/resume`, { method: "POST" });
}

function ctx() {
  return { params: Promise.resolve({ broadcastId: BROADCAST_ID }) };
}

beforeEach(() => {
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "member" };
  repositories.broadcasts.getById.mockClear();
  repositories.broadcasts.setPaused.mockClear();
});

describe("POST /api/broadcasts/[broadcastId]/resume", () => {
  it("refuses a member (below the manager minimum) and writes nothing", async () => {
    const res = await POST(post() as never, ctx() as never);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("forbidden");
    expect(repositories.broadcasts.getById).not.toHaveBeenCalled();
    expect(repositories.broadcasts.setPaused).not.toHaveBeenCalled();
  });
});
