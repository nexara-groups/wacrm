import { describe, expect, it } from "vitest";
import { dispositionIsRetryable, dispositionSuppressesNumber, DISPOSITIONS } from "./disposition";

describe("Disposition", () => {
  it("has exactly the four dispositions from META_ERROR_TAXONOMY.md §2", () => {
    expect(DISPOSITIONS).toEqual(["TRANSIENT", "THROTTLED", "PERMANENT_NUMBER", "PERMANENT_CONFIG"]);
  });

  it("only PERMANENT_NUMBER suppresses the number", () => {
    expect(dispositionSuppressesNumber("PERMANENT_NUMBER")).toBe(true);
    expect(dispositionSuppressesNumber("PERMANENT_CONFIG")).toBe(false);
    expect(dispositionSuppressesNumber("TRANSIENT")).toBe(false);
    expect(dispositionSuppressesNumber("THROTTLED")).toBe(false);
  });

  it("TRANSIENT and THROTTLED are retryable; the PERMANENT_* dispositions are not", () => {
    expect(dispositionIsRetryable("TRANSIENT")).toBe(true);
    expect(dispositionIsRetryable("THROTTLED")).toBe(true);
    expect(dispositionIsRetryable("PERMANENT_NUMBER")).toBe(false);
    expect(dispositionIsRetryable("PERMANENT_CONFIG")).toBe(false);
  });
});
