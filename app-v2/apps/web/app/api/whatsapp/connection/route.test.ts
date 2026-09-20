import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The properties under test are the three in the route's header: the token
 * never travels back out, the tenant is never taken from the body, and only
 * an owner can write.
 */
const OWNER_TENANT = "c92487e4-b4a8-45b1-b605-065099b7fa0d";

const configs: Record<string, unknown[]> = { [OWNER_TENANT]: [] };
const saved: unknown[] = [];
const replaced: unknown[] = [];
let role = "owner";

vi.mock("@/lib/container", () => ({
  getContainer: async () => ({
    repositories: {
      whatsappConfig: {
        listByAccount: async (accountId: string) => configs[accountId] ?? [],
      },
    },
    tenant: { tenantId: OWNER_TENANT },
    ownerUserId: "u1",
  }),
}));

vi.mock("@/lib/session", () => ({
  getCurrentAuth: async () => ({
    user: { userId: "u1", tenantId: OWNER_TENANT, role },
    tenant: { tenantId: OWNER_TENANT },
    accessToken: "t",
  }),
}));

vi.mock("@/lib/whatsapp-container", () => ({
  getWhatsAppContainer: async () => ({
    service: {
      saveConfig: async (input: Record<string, unknown>) => {
        saved.push(input);
        return { ...input, id: "cfg-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
      },
      // Recorded separately from saveConfig: which of the two a number change
      // goes through is the whole point — `upsert` would leave the old row in
      // place and every send would keep using it.
      replaceConfig: async (input: Record<string, unknown>) => {
        replaced.push(input);
        return { ...input, id: "cfg-2", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" };
      },
    },
  }),
}));

const { GET, PUT } = await import("./route");

function put(body: Record<string, unknown>): Request {
  return new Request("https://x.test/api/whatsapp/connection", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = { wabaId: "waba-1", phoneNumberId: "pn-1", accessToken: "EAAG-secret-token-value" };

beforeEach(() => {
  configs[OWNER_TENANT] = [];
  saved.length = 0;
  replaced.length = 0;
  role = "owner";
});

describe("GET /api/whatsapp/connection", () => {
  it("reports no connection for an account that has none", async () => {
    const body = await (await GET()).json();
    expect(body).toEqual({ ok: true, connection: null });
  });

  it("never includes the access token, only that one exists", async () => {
    configs[OWNER_TENANT] = [
      {
        id: "cfg-1", accountId: OWNER_TENANT, phoneNumberId: "pn-1", wabaId: "waba-1",
        displayName: "Acme", verifiedName: "Acme Inc", qualityRating: "GREEN",
        registrationState: "registered", accessToken: "EAAG-secret-token-value",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ];

    const response = await GET();
    const text = await response.text();

    expect(text).not.toContain("EAAG-secret-token-value");
    expect(JSON.parse(text).connection).toMatchObject({ phoneNumberId: "pn-1", hasAccessToken: true });
  });
});

describe("PUT /api/whatsapp/connection", () => {
  it("saves a first connection and answers without the token", async () => {
    const response = await PUT(put(VALID) as never);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain(VALID.accessToken);
    expect(JSON.parse(text).connection.hasAccessToken).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ accountId: OWNER_TENANT, phoneNumberId: "pn-1", registrationState: "pending" });
  });

  it("refuses a non-owner and writes nothing", async () => {
    for (const forbidden of ["admin", "manager", "member"]) {
      role = forbidden;
      const response = await PUT(put(VALID) as never);
      expect(response.status, forbidden).toBe(403);
      expect((await response.json()).error.code).toBe("forbidden");
    }
    expect(saved).toEqual([]);
  });

  it("ignores an accountId in the body — the tenant comes from the session", async () => {
    await PUT(put({ ...VALID, accountId: "someone-elses-account" }) as never);
    expect(saved[0]).toMatchObject({ accountId: OWNER_TENANT });
  });

  it("keeps a completed registration when only the token is re-entered", async () => {
    configs[OWNER_TENANT] = [
      {
        id: "cfg-1", accountId: OWNER_TENANT, phoneNumberId: "pn-1", wabaId: "waba-1",
        displayName: "Acme", verifiedName: "Acme Inc", qualityRating: "GREEN",
        registrationState: "registered", accessToken: "old-token",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    await PUT(put({ ...VALID, accessToken: "EAAG-rotated" }) as never);

    // Re-entering a token must not undo a registration Meta already granted,
    // nor blank the display/verified name the webhook filled in.
    expect(saved[0]).toMatchObject({
      registrationState: "registered", displayName: "Acme", verifiedName: "Acme Inc", qualityRating: "GREEN",
    });
  });

  it("REPLACES the config when the number changes, rather than adding a second one", async () => {
    configs[OWNER_TENANT] = [
      {
        id: "cfg-1", accountId: OWNER_TENANT, phoneNumberId: "pn-old", wabaId: "waba-old",
        displayName: "Old Name", verifiedName: "Old Verified", qualityRating: "GREEN",
        registrationState: "registered", accessToken: "old-token",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const response = await PUT(put(VALID) as never);

    expect(response.status).toBe(200);
    // Through replaceConfig, never saveConfig: the latter is keyed on the
    // phone number and would leave "pn-old" in place, still sending.
    expect(saved).toEqual([]);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ accountId: OWNER_TENANT, phoneNumberId: "pn-1" });
  });

  it("does not label a new number with the old number's names or rating", async () => {
    // displayName/verifiedName/qualityRating describe the number Meta issued
    // them for. Carrying them across would show the previous number's
    // verified name beside the new one.
    configs[OWNER_TENANT] = [
      {
        id: "cfg-1", accountId: OWNER_TENANT, phoneNumberId: "pn-old", wabaId: "waba-old",
        displayName: "Old Name", verifiedName: "Old Verified", qualityRating: "GREEN",
        registrationState: "registered", accessToken: "old-token",
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    await PUT(put(VALID) as never);

    expect(replaced[0]).toMatchObject({
      displayName: null,
      verifiedName: null,
      qualityRating: null,
      // Nothing has registered the new number yet, whatever the old one's state was.
      registrationState: "pending",
    });
  });

  it("rejects a missing token without touching storage", async () => {
    // 400, not 422: `validationError` is this codebase's one shape for a body
    // that failed its zod contract, and it answers 400 everywhere.
    const response = await PUT(put({ wabaId: "waba-1", phoneNumberId: "pn-1" }) as never);
    expect(response.status).toBe(400);
    expect(saved).toEqual([]);
  });
});
