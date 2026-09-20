import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `broadcasts:preview`'s minimum role is "manager" — a "member" is below
 * it, proving both the 403 and that the gate runs before the contacts
 * repository is touched.
 */
const TENANT_ID = "11111111-1111-1111-8111-111111111111";

let sessionUser: { userId: string; tenantId: string; role: string } = {
  userId: "u1",
  tenantId: TENANT_ID,
  role: "member",
};

const repositories = {
  contacts: {
    findById: vi.fn(async () => null),
    listTags: vi.fn(async () => []),
    search: vi.fn(async () => ({ items: [], total: 0 })),
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
  return new Request("https://example.test/api/broadcasts/preview-audience", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "member" };
  repositories.contacts.findById.mockClear();
  repositories.contacts.search.mockClear();
});

describe("POST /api/broadcasts/preview-audience", () => {
  it("refuses a member (below the manager minimum) and reads nothing", async () => {
    const res = await POST(post({ audienceFilter: {} }) as never);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("forbidden");
    expect(repositories.contacts.search).not.toHaveBeenCalled();
    expect(repositories.contacts.findById).not.toHaveBeenCalled();
  });
});
