import { describe, expect, it } from "vitest";
import { z } from "zod";
import { booleanQueryFlagSchema } from "./query-flag";

describe("booleanQueryFlagSchema", () => {
  it("reads the string 'false' as false — the exact case z.coerce.boolean() gets wrong", () => {
    // The bug being fixed, stated as an executable fact: zod's coercion is
    // Boolean(value), so the string "false" coerces to TRUE. If someone
    // swaps this schema back for z.coerce.boolean(), this test fails.
    expect(z.coerce.boolean().parse("false")).toBe(true);
    expect(booleanQueryFlagSchema.parse("false")).toBe(false);
  });

  it("reads the string 'true' as true", () => {
    expect(booleanQueryFlagSchema.parse("true")).toBe(true);
  });

  it("passes real booleans through unchanged, so a JSON body can use it too", () => {
    expect(booleanQueryFlagSchema.parse(true)).toBe(true);
    expect(booleanQueryFlagSchema.parse(false)).toBe(false);
  });

  it("rejects anything else rather than silently answering true", () => {
    for (const bad of ["1", "0", "yes", "no", "TRUE", "", 1, 0, null]) {
      expect(() => booleanQueryFlagSchema.parse(bad)).toThrow();
    }
  });
});
