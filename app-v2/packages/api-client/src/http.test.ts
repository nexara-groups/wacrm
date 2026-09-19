import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiResult } from "@packages/contracts/src/index";
import { apiRequest, buildQueryString, type ApiClientContext, type FetchLike } from "./http";

// A small, self-contained `apiResult(...)`-shaped schema — every real
// endpoint schema in `@packages/contracts` is built the exact same way
// (`apiResult({ ...shape })`), so exercising the transport against this one
// exercises the same discriminated-union parsing path every resource
// method relies on.
const testResponseSchema = apiResult({ value: z.string(), count: z.number().int() });

function makeContext(fetchFn: FetchLike, headers: Record<string, string> = {}): ApiClientContext {
  return { baseUrl: "https://api.example.test", fetchFn, headers };
}

describe("apiRequest", () => {
  it("parses a valid 2xx response and returns typed data", async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      new Response(JSON.stringify({ ok: true, value: "hello", count: 3 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await apiRequest(makeContext(fetchFn), { method: "GET", path: "/thing" }, testResponseSchema);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ value: "hello", count: 3 });
    }
  });

  it("returns a parse error — not the wrong data — when the 2xx body has the wrong shape", async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      new Response(JSON.stringify({ ok: true, value: "hello", count: "not-a-number" }), { status: 200 }),
    );
    const result = await apiRequest(makeContext(fetchFn), { method: "GET", path: "/thing" }, testResponseSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("parse");
      if (result.error.kind === "parse") {
        expect(result.error.issues.length).toBeGreaterThan(0);
        expect(result.error.issues.some((issue) => issue.path.includes("count"))).toBe(true);
      }
    }
  });

  it("returns a parse error when a 2xx body is missing a required field entirely", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await apiRequest(makeContext(fetchFn), { method: "GET", path: "/thing" }, testResponseSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("parse");
  });

  it("maps a 4xx to the error envelope, preserving BOTH laymanMessage and operatorHint", async () => {
    const envelope = {
      code: "VALIDATION",
      laymanMessage: "That phone number doesn't look right.",
      operatorHint: "Reject and ask the operator to re-check the E.164 format before retrying.",
    };
    const fetchFn = vi.fn<FetchLike>(async () =>
      new Response(JSON.stringify({ ok: false, error: envelope }), { status: 422 }),
    );
    const result = await apiRequest(makeContext(fetchFn), { method: "POST", path: "/thing", body: {} }, testResponseSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("http");
      if (result.error.kind === "http") {
        expect(result.error.status).toBe(422);
        expect(result.error.error.laymanMessage).toBe(envelope.laymanMessage);
        expect(result.error.error.operatorHint).toBe(envelope.operatorHint);
      }
    }
  });

  it("maps a 5xx to the error envelope the same way as a 4xx", async () => {
    const envelope = { code: "PROVIDER", laymanMessage: "We couldn't reach WhatsApp. Please try again shortly." };
    const fetchFn = vi.fn<FetchLike>(async () =>
      new Response(JSON.stringify({ ok: false, error: envelope }), { status: 503 }),
    );
    const result = await apiRequest(makeContext(fetchFn), { method: "POST", path: "/thing", body: {} }, testResponseSchema);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "http") {
      expect(result.error.status).toBe(503);
      expect(result.error.error.laymanMessage).toBe(envelope.laymanMessage);
      expect(result.error.error.operatorHint).toBeUndefined();
    }
  });

  it("distinguishes a network rejection from an HTTP error status", async () => {
    const networkFetch = vi.fn<FetchLike>(async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.example.test");
    });
    const networkResult = await apiRequest(makeContext(networkFetch), { method: "GET", path: "/thing" }, testResponseSchema);

    const httpFetch = vi.fn<FetchLike>(async () =>
      new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", laymanMessage: "Not found." } }), {
        status: 404,
      }),
    );
    const httpResult = await apiRequest(makeContext(httpFetch), { method: "GET", path: "/thing" }, testResponseSchema);

    expect(networkResult.ok).toBe(false);
    expect(httpResult.ok).toBe(false);
    if (!networkResult.ok && !httpResult.ok) {
      expect(networkResult.error.kind).toBe("network");
      expect(httpResult.error.kind).toBe("http");
      expect(networkResult.error.kind).not.toBe(httpResult.error.kind);
      if (networkResult.error.kind === "network") {
        expect(networkResult.error.message).toContain("fetch failed");
        expect(networkResult.error.cause).toBeInstanceOf(TypeError);
      }
    }
  });

  it("falls back to a synthesized http error for a non-JSON 5xx body, distinct from a network error", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => new Response("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    const result = await apiRequest(makeContext(fetchFn), { method: "GET", path: "/thing" }, testResponseSchema);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("http");
      if (result.error.kind === "http") {
        expect(result.error.status).toBe(502);
        expect(result.error.error.laymanMessage.length).toBeGreaterThan(0);
      }
    }
  });

  it("sends the injected fetch, not globalThis.fetch — proving the network is never touched", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ ok: true, value: "x", count: 1 }), { status: 200 }));
    await apiRequest(makeContext(fetchFn), { method: "GET", path: "/thing" }, testResponseSchema);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("merges configured headers and sets Content-Type only when a body is present", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ ok: true, value: "x", count: 1 }), { status: 200 }));
    const ctx = makeContext(fetchFn, { Authorization: "Bearer token123" });

    await apiRequest(ctx, { method: "GET", path: "/thing" }, testResponseSchema);
    const getHeaders = fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(getHeaders["Authorization"]).toBe("Bearer token123");
    expect(getHeaders["Content-Type"]).toBeUndefined();

    await apiRequest(ctx, { method: "POST", path: "/thing", body: { a: 1 } }, testResponseSchema);
    const postHeaders = fetchFn.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(postHeaders["Authorization"]).toBe("Bearer token123");
    expect(postHeaders["Content-Type"]).toBe("application/json");
    expect(fetchFn.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ a: 1 }));
  });
});

describe("buildQueryString", () => {
  it("returns an empty string for no params", () => {
    expect(buildQueryString(undefined)).toBe("");
    expect(buildQueryString({})).toBe("");
  });

  it("encodes pagination and filter fields", () => {
    const qs = buildQueryString({ page: 2, pageSize: 50, tag: "vip", search: "acme corp" });
    const params = new URLSearchParams(qs.slice(1));
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("50");
    expect(params.get("tag")).toBe("vip");
    expect(params.get("search")).toBe("acme corp");
  });

  it("omits undefined and null values entirely", () => {
    const qs = buildQueryString({ tag: undefined, search: null, page: 1 });
    expect(qs).toBe("?page=1");
  });

  it("encodes an explicit `false` as \"false\" — the contracts side parses it back to false", () => {
    // Only safe because query flags use `booleanQueryFlagSchema`, not
    // `z.coerce.boolean()`, which would read "false" as true. If that ever
    // regresses, the contract's own test fails first and this one documents
    // why the client stopped omitting `false`.
    expect(buildQueryString({ unreadOnly: false, page: 1 })).toBe("?unreadOnly=false&page=1");
  });

  it("encodes an explicit `true`", () => {
    const qs = buildQueryString({ unreadOnly: true });
    expect(qs).toBe("?unreadOnly=true");
  });

  it("repeats the key for array values", () => {
    const qs = buildQueryString({ tag: ["vip", "lead"] });
    const params = new URLSearchParams(qs.slice(1));
    expect(params.getAll("tag")).toEqual(["vip", "lead"]);
  });
});
