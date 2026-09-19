import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { apiResult } from "./response";
import { errorEnvelopeSchema, type ErrorEnvelope } from "./error-envelope";

describe("apiResult", () => {
  const schema = apiResult({ widget: z.object({ id: z.string() }) });

  it("parses a success payload", () => {
    const result = schema.safeParse({ ok: true, widget: { id: "abc" } });
    expect(result.success).toBe(true);
  });

  it("parses an error payload using the shared error envelope", () => {
    const result = schema.safeParse({
      ok: false,
      error: { code: "VALIDATION", laymanMessage: "Something was wrong with that." },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a success payload missing the declared success field", () => {
    const result = schema.safeParse({ ok: true });
    expect(result.success).toBe(false);
  });

  it("rejects an invented error shape that isn't the shared envelope", () => {
    const result = schema.safeParse({ ok: false, error: { message: "nope, wrong shape" } });
    expect(result.success).toBe(false);
  });

  it("rejects a value that is neither a success nor an error branch", () => {
    const result = schema.safeParse({ ok: "maybe" });
    expect(result.success).toBe(false);
  });

  it("the error branch's `error` field is exactly ErrorEnvelope", () => {
    type Parsed = z.infer<typeof schema>;
    type ErrorBranch = Extract<Parsed, { ok: false }>;
    expectTypeOf<ErrorBranch["error"]>().toEqualTypeOf<ErrorEnvelope>();
  });

  it("apiResult({}) allows an empty success payload beyond the ok flag", () => {
    const empty = apiResult({});
    expect(empty.safeParse({ ok: true }).success).toBe(true);
    expect(empty.safeParse({ ok: false, error: errorEnvelopeSchema.parse({ code: "NOT_FOUND", laymanMessage: "Not found." }) }).success).toBe(true);
  });
});
