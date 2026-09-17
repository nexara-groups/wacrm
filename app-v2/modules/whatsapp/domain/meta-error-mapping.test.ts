import { describe, expect, it } from "vitest";
import { classifyMetaFailure, extractParameterName, toMetaError, toProviderFailure } from "./meta-error-mapping";

describe("extractParameterName", () => {
  it("prefers an explicit error_data.parameter field when present", () => {
    expect(extractParameterName({ error_data: { parameter: "to" } })).toBe("to");
  });

  it("extracts a recognisable phone-parameter hint from free text", () => {
    expect(extractParameterName({ message: "Invalid parameter: to" })).toBe("to");
    expect(extractParameterName({ error_data: { details: "recipient number is invalid" } })).toBe("recipient");
  });

  it("returns undefined when nothing recognisable is present", () => {
    expect(extractParameterName({ message: "Something went wrong" })).toBeUndefined();
    expect(extractParameterName({})).toBeUndefined();
  });
});

describe("toMetaError", () => {
  it("maps every field, preferring message over title", () => {
    const result = toMetaError({
      code: 131026,
      error_subcode: 2494055,
      message: "Message undeliverable",
      title: "fallback title",
      httpStatus: 400,
    });
    expect(result).toMatchObject({
      code: 131026,
      subcode: 2494055,
      message: "Message undeliverable",
      httpStatus: 400,
    });
  });

  it("falls back to title when message is absent (the webhook errors[] shape)", () => {
    const result = toMetaError({ code: 131026, title: "Message undeliverable" });
    expect(result.message).toBe("Message undeliverable");
  });
});

describe("classifyMetaFailure", () => {
  it("classifies a known PERMANENT_NUMBER code", () => {
    const classification = classifyMetaFailure({ code: 131026 });
    expect(classification.disposition).toBe("PERMANENT_NUMBER");
    expect(classification.laymanMessage).not.toMatch(/131026/);
  });

  it("classifies 131049 as THROTTLED, never PERMANENT_NUMBER (regression guard)", () => {
    expect(classifyMetaFailure({ code: 131049 }).disposition).toBe("THROTTLED");
  });

  it("classifies an unrecognised code as TRANSIENT with a low retry cap", () => {
    const classification = classifyMetaFailure({ code: 999999 });
    expect(classification.disposition).toBe("TRANSIENT");
    expect(classification.retryMax).toBe(2);
  });

  it("classifies a network failure as TRANSIENT", () => {
    expect(classifyMetaFailure({ isNetworkError: true }).disposition).toBe("TRANSIENT");
  });

  it("classifies an HTTP 5xx with no Meta code as TRANSIENT", () => {
    expect(classifyMetaFailure({ httpStatus: 503 }).disposition).toBe("TRANSIENT");
  });
});

describe("toProviderFailure", () => {
  it("bundles the MetaError and its Classification together", () => {
    const failure = toProviderFailure({ code: 131021 });
    expect(failure.metaError.code).toBe(131021);
    expect(failure.classification.disposition).toBe("PERMANENT_NUMBER");
  });
});
