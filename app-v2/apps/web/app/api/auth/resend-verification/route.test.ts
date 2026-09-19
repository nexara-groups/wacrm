import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The property under test is that this endpoint reveals NOTHING about which
 * addresses have accounts. It is unauthenticated by necessity — the caller
 * cannot log in, that being the problem it solves — so a response that
 * distinguished "no such account" from "sent" would hand anyone a free
 * account-existence oracle.
 */
const sends: unknown[] = [];
const credentials = {
  rows: new Map<string, { tenantId: string; userId: string; email: string; verifiedAt: string | null }>(),
  async findByEmailAnyTenant(email: string) {
    return this.rows.get(email) ?? null;
  },
  createEmailVerification: vi.fn(async () => undefined),
};

vi.mock("@/lib/container", () => ({
  getBaseServices: async () => ({
    credentialsRepository: credentials,
    emailProvider: {
      name: "fake",
      send: async (message: { to?: string }) => {
        // One address is wired to fail, so the failure path can be exercised
        // without re-mocking the container mid-test.
        if (message.to === "boom@x.test") throw new Error("vendor down");
        sends.push(message);
      },
    },
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, enforced: true }),
}));

const { POST } = await import("./route");

function post(email: string): Request {
  return new Request("https://example.test/api/auth/resend-verification", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

beforeEach(() => {
  sends.length = 0;
  credentials.rows.clear();
  credentials.createEmailVerification.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/auth/resend-verification", () => {
  it("answers identically for an unknown address and an unverified one", async () => {
    credentials.rows.set("real@x.test", {
      tenantId: "acct-a", userId: "u1", email: "real@x.test", verifiedAt: null,
    });

    const unknown = await (await POST(post("nobody@x.test") as never)).json();
    const real = await (await POST(post("real@x.test") as never)).json();

    // Byte-identical bodies: nothing distinguishes the two cases.
    expect(unknown).toEqual(real);
    // ...while only the real one actually sent anything.
    expect(sends).toHaveLength(1);
  });

  it("answers identically for an ALREADY VERIFIED address, and sends nothing", async () => {
    credentials.rows.set("done@x.test", {
      tenantId: "acct-a", userId: "u1", email: "done@x.test", verifiedAt: "2026-01-01T00:00:00.000Z",
    });

    const verified = await (await POST(post("done@x.test") as never)).json();
    const unknown = await (await POST(post("nobody@x.test") as never)).json();

    expect(verified).toEqual(unknown);
    expect(sends).toHaveLength(0);
    expect(credentials.createEmailVerification).not.toHaveBeenCalled();
  });

  it("still answers success when the provider throws, revealing no failure", async () => {
    // A send failure must not tell the caller anything either — and must not
    // surface the provider's error, which can quote the payload and so the
    // raw token.
    credentials.rows.set("boom@x.test", {
      tenantId: "acct-a", userId: "u1", email: "boom@x.test", verifiedAt: null,
    });
    const response = await POST(post("boom@x.test") as never);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("vendor down");
  });

  it("issues a fresh token scoped to the credential's OWN tenant", async () => {
    credentials.rows.set("t@x.test", {
      tenantId: "acct-zzz", userId: "u9", email: "t@x.test", verifiedAt: null,
    });
    await POST(post("t@x.test") as never);

    const [tenant, input] = credentials.createEmailVerification.mock.calls[0] as unknown as [
      { tenantId: string },
      { userId: string; tokenHash: string },
    ];
    // Derived from the credential row, never from the request.
    expect(tenant.tenantId).toBe("acct-zzz");
    expect(input.userId).toBe("u9");
    expect(input.tokenHash).not.toBe("");
  });
});
