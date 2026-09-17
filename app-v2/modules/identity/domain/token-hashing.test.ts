import { describe, expect, it } from "vitest";
import { DUMMY_PASSWORD_HASH, generateToken, hashPassword, hashToken, verifyPassword } from "./token-hashing";

describe("token-hashing", () => {
  describe("hashPassword / verifyPassword (PBKDF2, salted)", () => {
    it("verifies the correct password against its own hash", async () => {
      const hash = await hashPassword("correct horse battery staple");
      await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    });

    it("rejects an incorrect password", async () => {
      const hash = await hashPassword("correct horse battery staple");
      await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
    });

    it("never stores the raw password in the encoded hash", async () => {
      const password = "super-secret-value-xyz";
      const hash = await hashPassword(password);
      expect(hash).not.toContain(password);
    });

    it("salts each hash differently, even for the same password", async () => {
      const a = await hashPassword("same-password");
      const b = await hashPassword("same-password");
      expect(a).not.toBe(b);
      // ...but both still verify correctly.
      await expect(verifyPassword("same-password", a)).resolves.toBe(true);
      await expect(verifyPassword("same-password", b)).resolves.toBe(true);
    });

    it("uses a scheme string that is neither bcrypt nor bare, unsalted SHA", async () => {
      const hash = await hashPassword("x");
      expect(hash.startsWith("pbkdf2-sha256$")).toBe(true);
      expect(hash.startsWith("$2")).toBe(false); // bcrypt's "$2a$"/"$2b$" prefix
    });

    it("rejects garbage-encoded hashes instead of throwing", async () => {
      await expect(verifyPassword("anything", "not-a-real-hash")).resolves.toBe(false);
      await expect(verifyPassword("anything", "")).resolves.toBe(false);
    });

    it("exposes a dummy hash usable for constant-time-ish lookup-miss comparisons", async () => {
      await expect(verifyPassword("whatever", DUMMY_PASSWORD_HASH)).resolves.toBe(false);
    });
  });

  describe("hashToken (deterministic SHA-256, for high-entropy opaque tokens)", () => {
    it("is deterministic — same input always hashes the same", async () => {
      const raw = generateToken();
      const a = await hashToken(raw);
      const b = await hashToken(raw);
      expect(a).toBe(b);
    });

    it("produces different hashes for different tokens", async () => {
      const a = await hashToken(generateToken());
      const b = await hashToken(generateToken());
      expect(a).not.toBe(b);
    });

    it("never returns the raw token as (or within) the hash", async () => {
      const raw = generateToken();
      const hash = await hashToken(raw);
      expect(hash).not.toBe(raw);
      expect(hash).not.toContain(raw);
    });
  });

  describe("generateToken", () => {
    it("produces high-entropy, URL-safe tokens with no padding/slashes/pluses", () => {
      const token = generateToken();
      expect(token.length).toBeGreaterThan(30);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("never repeats across calls", () => {
      const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));
      expect(tokens.size).toBe(50);
    });
  });
});
