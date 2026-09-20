import { describe, expect, it } from "vitest";
import { ALL_DISPOSITIONS, Disposition, isPermanent, marksContact } from "./disposition";

describe("disposition", () => {
  it("has exactly the four dispositions from the spec", () => {
    expect(new Set(ALL_DISPOSITIONS)).toEqual(
      new Set(["TRANSIENT", "THROTTLED", "PERMANENT_NUMBER", "PERMANENT_CONFIG"]),
    );
    expect(ALL_DISPOSITIONS).toHaveLength(4);
  });

  it("isPermanent is true only for the two PERMANENT_* dispositions", () => {
    expect(isPermanent(Disposition.PERMANENT_NUMBER)).toBe(true);
    expect(isPermanent(Disposition.PERMANENT_CONFIG)).toBe(true);
    expect(isPermanent(Disposition.TRANSIENT)).toBe(false);
    expect(isPermanent(Disposition.THROTTLED)).toBe(false);
  });

  it("marksContact is true only for PERMANENT_NUMBER", () => {
    expect(marksContact(Disposition.PERMANENT_NUMBER)).toBe(true);
    expect(marksContact(Disposition.PERMANENT_CONFIG)).toBe(false);
    expect(marksContact(Disposition.TRANSIENT)).toBe(false);
    expect(marksContact(Disposition.THROTTLED)).toBe(false);
  });
});
