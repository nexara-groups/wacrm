import { describe, expect, expectTypeOf, it } from "vitest";
import type { AccountId, ContactId, PhoneNumber } from "@packages/domain";
import {
  accountIdSchema,
  broadcastIdSchema,
  contactIdSchema,
  conversationIdSchema,
  isoDateTimeSchema,
  messageIdSchema,
  opaqueIdSchema,
  phoneNumberSchema,
  rawPhoneNumberInputSchema,
  templateIdSchema,
  userIdSchema,
} from "./ids";

const VALID_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("branded id schemas", () => {
  const SCHEMAS = {
    accountIdSchema,
    userIdSchema,
    contactIdSchema,
    conversationIdSchema,
    messageIdSchema,
    broadcastIdSchema,
    templateIdSchema,
  } as const;

  for (const [name, schema] of Object.entries(SCHEMAS)) {
    describe(name, () => {
      it("parses a well-formed UUID", () => {
        const result = schema.safeParse(VALID_UUID);
        expect(result.success).toBe(true);
        if (result.success) expect(result.data).toBe(VALID_UUID);
      });

      it("rejects a v6 UUID (domain's regex only permits versions 1-5)", () => {
        const v6 = "018f4d2e-0000-6000-8000-000000000000";
        expect(schema.safeParse(v6).success).toBe(false);
      });

      it("rejects a non-UUID string with a useful issue", () => {
        const result = schema.safeParse("not-a-uuid");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.message).toMatch(/UUID/);
        }
      });
    });
  }

  it("produces the exact branded type from @packages/domain, not a lookalike", () => {
    type Parsed = ReturnType<typeof accountIdSchema.parse>;
    expectTypeOf<Parsed>().toEqualTypeOf<AccountId>();
    type ParsedContact = ReturnType<typeof contactIdSchema.parse>;
    expectTypeOf<ParsedContact>().toEqualTypeOf<ContactId>();
  });
});

describe("phoneNumberSchema", () => {
  it("parses an already-normalised E.164 number", () => {
    const result = phoneNumberSchema.safeParse("+919876543210");
    expect(result.success).toBe(true);
  });

  it("rejects a number missing the leading +", () => {
    const result = phoneNumberSchema.safeParse("919876543210");
    expect(result.success).toBe(false);
  });

  it("infers domain's exact PhoneNumber brand", () => {
    type Parsed = ReturnType<typeof phoneNumberSchema.parse>;
    expectTypeOf<Parsed>().toEqualTypeOf<PhoneNumber>();
  });
});

describe("rawPhoneNumberInputSchema", () => {
  it("accepts loosely-formatted human input", () => {
    for (const raw of ["9876543210", "+91 98765 43210", "091-98765-43210"]) {
      expect(rawPhoneNumberInputSchema.safeParse(raw).success).toBe(true);
    }
  });

  it("rejects an empty string", () => {
    expect(rawPhoneNumberInputSchema.safeParse("").success).toBe(false);
  });
});

describe("opaqueIdSchema", () => {
  it("accepts any non-empty string", () => {
    expect(opaqueIdSchema.safeParse("row_123").success).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(opaqueIdSchema.safeParse("").success).toBe(false);
  });
});

describe("isoDateTimeSchema", () => {
  it("accepts a UTC ISO-8601 datetime", () => {
    expect(isoDateTimeSchema.safeParse("2024-03-14T10:00:00Z").success).toBe(true);
  });

  it("rejects a non-UTC offset (domain's ISODateString is UTC-only)", () => {
    expect(isoDateTimeSchema.safeParse("2024-03-14T10:00:00+05:30").success).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isoDateTimeSchema.safeParse("14 March 2024").success).toBe(false);
  });
});
