import { describe, expect, it } from "vitest";
import { AccountId, BroadcastId, ContactId, ConversationId, isValidId, MessageId, TemplateId, UserId } from "./ids";

const VALID_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

const CONSTRUCTORS = {
  AccountId,
  UserId,
  ContactId,
  ConversationId,
  MessageId,
  BroadcastId,
  TemplateId,
} as const;

describe("branded id constructors", () => {
  for (const [name, ctor] of Object.entries(CONSTRUCTORS)) {
    describe(name, () => {
      it("accepts a well-formed UUID", () => {
        expect(ctor(VALID_UUID)).toBe(VALID_UUID);
      });

      it("accepts an upper-case UUID and returns it trimmed/unchanged", () => {
        const upper = VALID_UUID.toUpperCase();
        expect(ctor(upper)).toBe(upper);
      });

      it("rejects an empty string", () => {
        expect(() => ctor("")).toThrow();
      });

      it("rejects a non-UUID string", () => {
        expect(() => ctor("not-a-uuid")).toThrow();
      });

      it("rejects a UUID-shaped string with one character missing", () => {
        expect(() => ctor(VALID_UUID.slice(0, -1))).toThrow();
      });

      it("rejects a numeric-looking id", () => {
        expect(() => ctor("12345")).toThrow();
      });

      it("rejects non-string input", () => {
        // @ts-expect-error — constructors must reject non-string input at the type level too.
        expect(() => ctor(12345)).toThrow();
      });
    });
  }
});

describe("isValidId", () => {
  it("returns true for a valid UUID", () => {
    expect(isValidId(VALID_UUID)).toBe(true);
  });

  it("returns false for garbage", () => {
    expect(isValidId("nope")).toBe(false);
    expect(isValidId(42)).toBe(false);
    expect(isValidId(null)).toBe(false);
  });
});
