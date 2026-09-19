import { describe, expect, it } from "vitest";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  checkPassword,
} from "./password-policy";

describe("checkPassword", () => {
  it("accepts a password at exactly the minimum length", () => {
    const atMinimum = "a".repeat(MIN_PASSWORD_LENGTH);
    expect(checkPassword(atMinimum).ok).toBe(true);
  });

  it("rejects one character below the minimum", () => {
    const result = checkPassword("a".repeat(MIN_PASSWORD_LENGTH - 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toEqual({ kind: "too_short", minLength: MIN_PASSWORD_LENGTH });
  });

  it("rejects blank and whitespace-only passwords before complaining about length", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      const result = checkPassword(blank);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.rejection.kind).toBe("blank");
    }
  });

  it("counts code points, not UTF-16 units", () => {
    // 12 emoji are 24 UTF-16 units. Counting units would accept a password
    // the person sees as 12 characters while a 12-letter one is rejected —
    // or worse, the reverse. Count what they typed.
    expect(checkPassword("👍".repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
    const tooFew = checkPassword("👍".repeat(MIN_PASSWORD_LENGTH - 1));
    expect(tooFew.ok).toBe(false);
    if (!tooFew.ok) expect(tooFew.rejection.kind).toBe("too_short");
  });

  it("rejects an absurdly long password, because PBKDF2 hashes whatever it is given", () => {
    const result = checkPassword("a".repeat(MAX_PASSWORD_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toEqual({ kind: "too_long", maxLength: MAX_PASSWORD_LENGTH });
    expect(checkPassword("a".repeat(MAX_PASSWORD_LENGTH)).ok).toBe(true);
  });

  it("imposes no composition rules — a long passphrase of plain words passes", () => {
    // NIST SP 800-63B advises against mandated composition rules; they
    // produce `Password1!` rather than security.
    expect(checkPassword("correct horse battery staple").ok).toBe(true);
    expect(checkPassword("alllowercaselettersonly").ok).toBe(true);
  });

  it("every rejection carries customer-facing copy with no jargon", () => {
    for (const bad of ["", "short", "a".repeat(MAX_PASSWORD_LENGTH + 1)]) {
      const result = checkPassword(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.laymanMessage.length).toBeGreaterThan(0);
        expect(result.laymanMessage).not.toMatch(/PBKDF2|iteration|hash|bcrypt/i);
      }
    }
  });
});
