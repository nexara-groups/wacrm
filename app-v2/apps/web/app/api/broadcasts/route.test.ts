import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `broadcasts:write`'s minimum role is "manager" — a "member" is below it,
 * proving both the 403 and that the gate runs before the repository or the
 * template lookup are touched.
 */
const TENANT_ID = "11111111-1111-1111-8111-111111111111";

let sessionUser: { userId: string; tenantId: string; role: string } = {
  userId: "u1",
  tenantId: TENANT_ID,
  role: "member",
};

const repositories = {
  messageTemplates: {
    findById: vi.fn(async () => null),
  },
  broadcasts: {
    create: vi.fn(async () => ({})),
    updateStatus: vi.fn(async () => {}),
    getById: vi.fn(async () => null),
  },
};

vi.mock("@/lib/container", () => ({
  getContainer: async () => ({ repositories, tenant: { tenantId: TENANT_ID }, ownerUserId: "u1" }),
}));
vi.mock("@/lib/session", () => ({
  getCurrentAuth: async () => ({ user: sessionUser, tenant: { tenantId: TENANT_ID }, accessToken: "t" }),
}));

const { POST } = await import("./route");

function post(body: unknown): Request {
  return new Request("https://example.test/api/broadcasts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "member" };
  repositories.messageTemplates.findById.mockClear();
  repositories.broadcasts.create.mockClear();
});

describe("POST /api/broadcasts", () => {
  it("refuses a member (below the manager minimum) and writes nothing", async () => {
    const res = await POST(post({ name: "Sale", templateId: "tpl-1" }) as never);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("forbidden");
    expect(repositories.messageTemplates.findById).not.toHaveBeenCalled();
    expect(repositories.broadcasts.create).not.toHaveBeenCalled();
  });
});
