import { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BroadcastStatus as DomainBroadcastStatus,
  ConsentState as DomainConsentState,
  DeliverabilityState as DomainDeliverabilityState,
  Disposition as DomainDisposition,
  MessageDirection as DomainMessageDirection,
  MessageType as DomainMessageType,
  OptOutScope as DomainOptOutScope,
  OptOutSource as DomainOptOutSource,
  RecipientStatus as DomainRecipientStatus,
  TemplateApprovalStatus as DomainTemplateApprovalStatus,
  TemplateCategory as DomainTemplateCategory,
  CountryCode as DomainCountryCode,
} from "@packages/domain";
import {
  broadcastStatusSchema,
  consentStateSchema,
  countryCodeSchema,
  deliverabilityStateSchema,
  dispositionSchema,
  invitableRoleSchema,
  messageDirectionSchema,
  messageTypeSchema,
  optOutScopeSchema,
  optOutSourceSchema,
  recipientStatusSchema,
  roleSchema,
  templateApprovalStatusSchema,
  templateCategorySchema,
  type BroadcastStatus,
  type ConsentState,
  type CountryCode,
  type DeliverabilityState,
  type Disposition,
  type MessageDirection,
  type MessageType,
  type OptOutScope,
  type OptOutSource,
  type RecipientStatus,
  type TemplateApprovalStatus,
  type TemplateCategory,
} from "./vocab";

describe("vocab enums accept every literal and reject unknown values", () => {
  const CASES: Array<[string, z.ZodType, readonly string[]]> = [
    ["broadcastStatusSchema", broadcastStatusSchema, ["draft", "scheduled", "sending", "sent", "failed"]],
    [
      "recipientStatusSchema",
      recipientStatusSchema,
      ["pending", "sent", "delivered", "read", "replied", "failed"],
    ],
    ["dispositionSchema", dispositionSchema, ["TRANSIENT", "THROTTLED", "PERMANENT_NUMBER", "PERMANENT_CONFIG"]],
    ["deliverabilityStateSchema", deliverabilityStateSchema, ["unknown", "reachable", "suppressed", "manually_cleared"]],
    ["consentStateSchema", consentStateSchema, ["unknown", "opted_in", "opted_out", "do_not_contact"]],
    ["optOutSourceSchema", optOutSourceSchema, ["keyword", "quick_reply", "inferred_block", "operator", "import"]],
    ["messageDirectionSchema", messageDirectionSchema, ["inbound", "outbound"]],
    ["messageTypeSchema", messageTypeSchema, ["text", "template", "media", "interactive", "system"]],
    ["templateCategorySchema", templateCategorySchema, ["marketing", "utility", "authentication"]],
    [
      "templateApprovalStatusSchema",
      templateApprovalStatusSchema,
      ["pending", "approved", "rejected", "paused", "disabled"],
    ],
    ["countryCodeSchema", countryCodeSchema, ["IN", "US", "CA", "GB", "AE", "AU", "SG"]],
    ["roleSchema", roleSchema, ["owner", "admin", "manager", "member"]],
  ];

  for (const [name, schema, values] of CASES) {
    describe(name, () => {
      it(`accepts every documented literal`, () => {
        for (const value of values) {
          expect(schema.safeParse(value).success, `${name} should accept "${value}"`).toBe(true);
        }
      });

      it("rejects an unrecognised value with a useful issue", () => {
        const result = schema.safeParse("totally-not-a-real-value");
        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected the parse to fail");
        expect(result.error.issues.length).toBeGreaterThan(0);
      });
    });
  }
});

describe("optOutScopeSchema", () => {
  it('accepts only "all" (category scoping is provisioned, not built)', () => {
    expect(optOutScopeSchema.safeParse("all").success).toBe(true);
    expect(optOutScopeSchema.safeParse("marketing").success).toBe(false);
  });
});

describe("invitableRoleSchema", () => {
  it("accepts every role except owner", () => {
    expect(invitableRoleSchema.safeParse("admin").success).toBe(true);
    expect(invitableRoleSchema.safeParse("manager").success).toBe(true);
    expect(invitableRoleSchema.safeParse("member").success).toBe(true);
  });

  it("rejects owner — SEAT_LIMITS.md §1 account_invitations CHECK (role <> 'owner')", () => {
    expect(invitableRoleSchema.safeParse("owner").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compile-time vocabulary parity with @packages/domain. These are the tests
// that stand in for the runtime import this package deliberately does not
// take — see vocab.ts's top-of-file comment. If domain ever adds, removes
// or renames a literal in one of these unions, ONE of these assertions
// fails to compile and someone has to update vocab.ts by hand; there is no
// automatic/runtime enforcement of this parity.
// ---------------------------------------------------------------------------

describe("vocab-domain type parity (compile-time only)", () => {
  it("string-union vocab types equal their @packages/domain counterparts", () => {
    expectTypeOf<BroadcastStatus>().toEqualTypeOf<DomainBroadcastStatus>();
    expectTypeOf<RecipientStatus>().toEqualTypeOf<DomainRecipientStatus>();
    expectTypeOf<Disposition>().toEqualTypeOf<DomainDisposition>();
    expectTypeOf<DeliverabilityState>().toEqualTypeOf<DomainDeliverabilityState>();
    expectTypeOf<ConsentState>().toEqualTypeOf<DomainConsentState>();
    expectTypeOf<OptOutSource>().toEqualTypeOf<DomainOptOutSource>();
    expectTypeOf<OptOutScope>().toEqualTypeOf<DomainOptOutScope>();
    expectTypeOf<MessageDirection>().toEqualTypeOf<DomainMessageDirection>();
    expectTypeOf<MessageType>().toEqualTypeOf<DomainMessageType>();
    expectTypeOf<TemplateCategory>().toEqualTypeOf<DomainTemplateCategory>();
    expectTypeOf<TemplateApprovalStatus>().toEqualTypeOf<DomainTemplateApprovalStatus>();
    expectTypeOf<CountryCode>().toEqualTypeOf<DomainCountryCode>();
    expect(true).toBe(true);
  });
});
