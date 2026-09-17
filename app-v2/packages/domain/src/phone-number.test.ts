import { describe, expect, it } from "vitest";
import {
  isValidPhoneNumber,
  parsePhoneNumber,
  phoneNumbersEqual,
  tryParsePhoneNumber,
} from "./phone-number";

describe("parsePhoneNumber", () => {
  it("round-trips an already-E.164 Indian number", () => {
    const p = parsePhoneNumber("+919876543210");
    expect(p).toBe("+919876543210");
    // round-trip: parsing the canonical output again yields the same value.
    expect(parsePhoneNumber(p)).toBe(p);
  });

  it("normalises an Indian number given without +91", () => {
    expect(parsePhoneNumber("9876543210", "IN")).toBe("+919876543210");
  });

  it("normalises an Indian number with a leading 0 (trunk prefix)", () => {
    expect(parsePhoneNumber("09876543210", "IN")).toBe("+919876543210");
  });

  it("normalises an Indian number typed with 91 but no +", () => {
    expect(parsePhoneNumber("919876543210", "IN")).toBe("+919876543210");
  });

  it("normalises a formatted Indian number (spaces, hyphens)", () => {
    expect(parsePhoneNumber("+91 98765 43210", "IN")).toBe("+919876543210");
    expect(parsePhoneNumber("091-98765-43210", "IN")).toBe("+919876543210");
    expect(parsePhoneNumber("(091) 98765 43210", "IN")).toBe("+919876543210");
  });

  it("normalises a 00-international-prefixed Indian number", () => {
    expect(parsePhoneNumber("0091 9876543210", "IN")).toBe("+919876543210");
  });

  it("two different spellings of the same number normalise equal (dedup guarantee)", () => {
    const a = parsePhoneNumber("9876543210", "IN");
    const b = parsePhoneNumber("+91-98765-43210");
    const c = parsePhoneNumber("09876543210", "IN");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("rejects an Indian national number of the wrong length", () => {
    expect(() => parsePhoneNumber("987654321", "IN")).toThrow(); // 9 digits
    expect(() => parsePhoneNumber("98765432100", "IN")).toThrow(); // 11 digits
  });

  it("rejects garbage input", () => {
    expect(() => parsePhoneNumber("", "IN")).toThrow();
    expect(() => parsePhoneNumber("not-a-number", "IN")).toThrow();
    expect(() => parsePhoneNumber("+1", "IN")).toThrow();
    expect(() => parsePhoneNumber("0000000000", "IN")).toThrow();
  });

  it("does not mangle a non-Indian E.164 number just because defaultCountry is IN", () => {
    // US number, explicit +, should never be reinterpreted as Indian.
    expect(parsePhoneNumber("+14155552671", "IN")).toBe("+14155552671");
  });

  it("resolves a US number without + when defaultCountry is US", () => {
    expect(parsePhoneNumber("4155552671", "US")).toBe("+14155552671");
  });

  it("tryParsePhoneNumber returns undefined instead of throwing", () => {
    expect(tryParsePhoneNumber("not-a-number")).toBeUndefined();
    expect(tryParsePhoneNumber("9876543210", "IN")).toBe("+919876543210");
  });

  it("isValidPhoneNumber reflects parse success", () => {
    expect(isValidPhoneNumber("9876543210", "IN")).toBe(true);
    expect(isValidPhoneNumber("nope")).toBe(false);
  });

  it("phoneNumbersEqual treats different spellings as equal, and different numbers as distinct", () => {
    expect(phoneNumbersEqual("9876543210", "+919876543210")).toBe(true);
    expect(phoneNumbersEqual("09876543210", "9876543210", "IN")).toBe(true);
    expect(phoneNumbersEqual("9876543210", "9876543211")).toBe(false);
  });
});
