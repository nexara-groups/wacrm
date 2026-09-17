import { describe, expect, it } from "vitest";
import { Disposition } from "./disposition";
import { classify } from "./meta-error-classifier";

describe("classify", () => {
  describe("every code in the spec table classifies to its expected disposition", () => {
    const cases: ReadonlyArray<readonly [number, Disposition]> = [
      [131026, Disposition.PERMANENT_NUMBER],
      [131021, Disposition.PERMANENT_NUMBER],
      [131047, Disposition.PERMANENT_CONFIG],
      [132001, Disposition.PERMANENT_CONFIG],
      [132000, Disposition.PERMANENT_CONFIG],
      [132015, Disposition.PERMANENT_CONFIG],
      [132016, Disposition.PERMANENT_CONFIG],
      [132012, Disposition.PERMANENT_CONFIG],
      [132005, Disposition.PERMANENT_CONFIG],
      [131031, Disposition.PERMANENT_CONFIG],
      [131042, Disposition.PERMANENT_CONFIG],
      [133010, Disposition.PERMANENT_CONFIG],
      [190, Disposition.PERMANENT_CONFIG],
      [10, Disposition.PERMANENT_CONFIG],
      [130429, Disposition.THROTTLED],
      [131048, Disposition.THROTTLED],
      [131056, Disposition.THROTTLED],
      [4, Disposition.THROTTLED],
      [80007, Disposition.THROTTLED],
      [133016, Disposition.THROTTLED],
      [131049, Disposition.THROTTLED],
      [131000, Disposition.TRANSIENT],
      [131016, Disposition.TRANSIENT],
      [133004, Disposition.TRANSIENT],
      [131052, Disposition.TRANSIENT],
      [131053, Disposition.TRANSIENT],
      [131057, Disposition.TRANSIENT],
    ];

    it.each(cases)("code %i -> %s", (code, expected) => {
      const result = classify({ code });
      expect(result.disposition).toBe(expected);
      expect(result.laymanMessage.length).toBeGreaterThan(0);
    });
  });

  it("200-299 permission-denied range classifies as PERMANENT_CONFIG for several sample codes", () => {
    for (const code of [200, 210, 250, 288, 299]) {
      const result = classify({ code });
      expect(result.disposition).toBe(Disposition.PERMANENT_CONFIG);
      expect(result.matchedKey).toBe("200-299");
    }
  });

  it("just outside the permission-denied range is not treated as the range", () => {
    expect(classify({ code: 199 }).matchedKey).not.toBe("200-299");
    expect(classify({ code: 300 }).matchedKey).not.toBe("200-299");
  });

  describe("131049 regression guard — always THROTTLED, never PERMANENT_NUMBER", () => {
    it("classifies 131049 as THROTTLED", () => {
      const result = classify({ code: 131049 });
      expect(result.disposition).toBe(Disposition.THROTTLED);
      expect(result.disposition).not.toBe(Disposition.PERMANENT_NUMBER);
    });

    it("carries the marketing-frequency-cap layman message, not a suppression message", () => {
      const result = classify({ code: 131049 });
      expect(result.laymanMessage).toBe(
        "Meta limited marketing messages to this person right now. We'll try again later.",
      );
    });
  });

  describe("unknown/unrecognised codes", () => {
    it("classifies an unrecognised code as TRANSIENT with retryMax 2, never PERMANENT_NUMBER", () => {
      const result = classify({ code: 999999 });
      expect(result.disposition).toBe(Disposition.TRANSIENT);
      expect(result.disposition).not.toBe(Disposition.PERMANENT_NUMBER);
      expect(result.retryMax).toBe(2);
    });

    it("classifies a missing code as TRANSIENT/unknown", () => {
      const result = classify({});
      expect(result.disposition).toBe(Disposition.TRANSIENT);
      expect(result.matchedKey).toBe("UNKNOWN");
    });

    it("never returns PERMANENT_NUMBER for any code outside the known PERMANENT_NUMBER set", () => {
      const knownPermanentNumberCodes = new Set([131026, 131021, 131009]);
      for (const code of [1, 2, 3, 5, 6, 7, 8, 9, 12345, 654321, 131099, 131050]) {
        if (knownPermanentNumberCodes.has(code)) continue;
        expect(classify({ code }).disposition).not.toBe(Disposition.PERMANENT_NUMBER);
      }
    });
  });

  describe("131009 — dual disposition by parameter name", () => {
    it("phone-shaped parameter names classify as PERMANENT_NUMBER", () => {
      const phoneParams = ["to", "phone_number", "recipient_number", "wa_id", "msisdn", "Phone"];
      for (const parameterName of phoneParams) {
        const result = classify({ code: 131009, parameterName });
        expect(result.disposition).toBe(Disposition.PERMANENT_NUMBER);
      }
    });

    it("non-phone parameter names classify as PERMANENT_CONFIG, not suppression", () => {
      const result = classify({ code: 131009, parameterName: "template.header.text" });
      expect(result.disposition).toBe(Disposition.PERMANENT_CONFIG);
    });

    it("ambiguous (missing parameterName) classifies as PERMANENT_CONFIG — the safer default", () => {
      const result = classify({ code: 131009 });
      expect(result.disposition).toBe(Disposition.PERMANENT_CONFIG);
    });

    it("empty-string parameterName is treated as ambiguous -> PERMANENT_CONFIG", () => {
      const result = classify({ code: 131009, parameterName: "   " });
      expect(result.disposition).toBe(Disposition.PERMANENT_CONFIG);
    });
  });

  describe("HTTP 5xx / network failures", () => {
    it("isNetworkError classifies as TRANSIENT", () => {
      const result = classify({ isNetworkError: true });
      expect(result.disposition).toBe(Disposition.TRANSIENT);
      expect(result.matchedKey).toBe("NETWORK");
    });

    it("httpStatus 500-599 classifies as TRANSIENT even with no Meta code", () => {
      for (const httpStatus of [500, 502, 503, 599]) {
        const result = classify({ httpStatus });
        expect(result.disposition).toBe(Disposition.TRANSIENT);
        expect(result.matchedKey).toBe("NETWORK");
      }
    });

    it("httpStatus 400 alone (no code) falls through to unknown, not network", () => {
      const result = classify({ httpStatus: 400 });
      expect(result.matchedKey).toBe("UNKNOWN");
    });

    it("network flag takes priority even if a code is also present", () => {
      const result = classify({ code: 131026, isNetworkError: true });
      expect(result.disposition).toBe(Disposition.TRANSIENT);
    });
  });

  it("never inlines a numeric code or raw Meta text into laymanMessage", () => {
    const sample = classify({ code: 131026, message: "raw meta developer string #131026" });
    expect(sample.laymanMessage).not.toContain("131026");
    expect(sample.laymanMessage).not.toContain("raw meta developer string");
  });
});
