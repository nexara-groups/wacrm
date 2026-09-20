import { describe, expect, it, vi } from "vitest";
import type { ApiClientContext, FetchLike } from "../http";
import { createContactsResource } from "./contacts";

const CONTACT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ACCOUNT_ID = "4fa85f64-5717-4562-b3fc-2c963f66afa6";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeCtx(fetchFn: FetchLike): ApiClientContext {
  return { baseUrl: "https://api.example.test", fetchFn, headers: {} };
}

const contact = {
  id: CONTACT_ID,
  accountId: ACCOUNT_ID,
  phoneNumber: "+919876543210",
  displayName: "Asha",
  email: null,
  tags: ["vip"],
  consentState: "opted_in",
  optedOutAt: null,
  optOutSource: null,
  optOutEvidence: null,
  optOutScope: "all",
  deliverabilityState: "reachable",
  suppressedAt: null,
  suppressedReasonCode: null,
  suppressionStrikes: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("contacts resource", () => {
  it("list() encodes pagination and filters into the query string", async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      jsonResponse({ ok: true, items: [], pagination: { page: 2, pageSize: 10, total: 0, totalPages: 1, from: 0, to: 0, hasPrevious: true, hasNext: false } }),
    );
    const contacts = createContactsResource(makeCtx(fetchFn));

    const result = await contacts.list({ page: 2, pageSize: 10, tag: "vip", search: "asha", consentState: "opted_in" });

    expect(result.ok).toBe(true);
    const url = new URL(fetchFn.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe("/contacts.list");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("10");
    expect(url.searchParams.get("tag")).toBe("vip");
    expect(url.searchParams.get("search")).toBe("asha");
    expect(url.searchParams.get("consentState")).toBe("opted_in");
  });

  it("search() is sugar over list() with the search term set, hitting the same endpoint", async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      jsonResponse({ ok: true, items: [contact], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1, from: 1, to: 1, hasPrevious: false, hasNext: false } }),
    );
    const contacts = createContactsResource(makeCtx(fetchFn));

    const result = await contacts.search("asha", { tag: "vip", page: 1, pageSize: 20 });

    expect(result.ok).toBe(true);
    const url = new URL(fetchFn.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe("/contacts.list");
    expect(url.searchParams.get("search")).toBe("asha");
    expect(url.searchParams.get("tag")).toBe("vip");
    if (result.ok) expect(result.value.items).toHaveLength(1);
  });

  it("get() returns a null contact as a SUCCESS, not an error, on a miss", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => jsonResponse({ ok: true, contact: null }));
    const contacts = createContactsResource(makeCtx(fetchFn));

    const result = await contacts.get(CONTACT_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.contact).toBeNull();
  });

  it("get() returns the parsed contact on a hit", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => jsonResponse({ ok: true, contact }));
    const contacts = createContactsResource(makeCtx(fetchFn));

    const result = await contacts.get(CONTACT_ID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.contact).toEqual(contact);
  });

  it("import() returns the structured result with rejections intact, never just a count", async () => {
    const importResult = {
      totalRows: 3,
      createdCount: 1,
      updatedCount: 1,
      consentPreservedCount: 0,
      rejectedCount: 1,
      rejections: [
        {
          rowNumber: 3,
          reason: "invalid_phone_number",
          message: "Row 3's phone number could not be read.",
          raw: { phoneNumber: "not-a-number" },
        },
      ],
    };
    const fetchFn = vi.fn<FetchLike>(async () => jsonResponse({ ok: true, result: importResult }));
    const contacts = createContactsResource(makeCtx(fetchFn));

    const result = await contacts.import({ rows: [{ phoneNumber: "+919876543210" }], defaultCountry: "IN" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.result).toEqual(importResult);
  });

  it("create() rejects (via the error envelope) when the server reports a validation failure", async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            code: "VALIDATION",
            laymanMessage: "That phone number doesn't look right.",
            operatorHint: "The number failed E.164 structural validation server-side.",
          },
        },
        400,
      ),
    );
    const contacts = createContactsResource(makeCtx(fetchFn));

    const result = await contacts.create({ phoneNumber: "abc", defaultCountry: "IN" });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "http") {
      expect(result.error.status).toBe(400);
      expect(result.error.error.laymanMessage).toBe("That phone number doesn't look right.");
      expect(result.error.error.operatorHint).toBe("The number failed E.164 structural validation server-side.");
    }
  });
});
