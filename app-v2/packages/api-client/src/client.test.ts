import { describe, expect, it, vi } from "vitest";
import { accountIdSchema } from "@packages/contracts/src/index";
import { createApiClient } from "./client";
import type { FetchLike } from "./http";

const ACCOUNT_ID = accountIdSchema.parse("3fa85f64-5717-4562-b3fc-2c963f66afa6");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("createApiClient", () => {
  it("uses the injected fetch, never the global one", async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      jsonResponse({ ok: true, usage: { accountId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", used: 2, limit: 5, remaining: 3, pendingInvitationCount: 0, hasPendingInvitations: false, isOverSeatLimit: false, statusMessage: null } }),
    );
    const globalFetchSpy = vi.spyOn(globalThis, "fetch");

    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: fetchFn });
    const result = await client.seats.getUsage({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(globalFetchSpy).not.toHaveBeenCalled();
    globalFetchSpy.mockRestore();
  });

  it("strips a trailing slash from baseUrl so paths don't end up double-slashed", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => jsonResponse({ ok: true, contact: null }));
    const client = createApiClient({ baseUrl: "https://api.example.test/", fetch: fetchFn });

    await client.contacts.get("3fa85f64-5717-4562-b3fc-2c963f66afa6");

    const calledUrl = fetchFn.mock.calls[0]?.[0] as string;
    expect(calledUrl.startsWith("https://api.example.test/contacts.get")).toBe(true);
    expect(calledUrl).not.toContain("//contacts.get");
  });

  it("merges configured headers onto every request across every resource", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => jsonResponse({ ok: true, contact: null }));
    const client = createApiClient({
      baseUrl: "https://api.example.test",
      fetch: fetchFn,
      headers: { Authorization: "Bearer secret-token" },
    });

    await client.contacts.get("3fa85f64-5717-4562-b3fc-2c963f66afa6");

    const headers = fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-token");
  });

  it("exposes every resource module named in the build brief", () => {
    const client = createApiClient({ baseUrl: "https://api.example.test", fetch: vi.fn() as unknown as FetchLike });
    expect(client.contacts).toBeDefined();
    expect(client.conversations).toBeDefined();
    expect(client.messages).toBeDefined();
    expect(client.broadcasts).toBeDefined();
    expect(client.templates).toBeDefined();
    expect(client.invitations).toBeDefined();
    expect(client.seats).toBeDefined();
    expect(client.onboarding).toBeDefined();
  });
});
