import { describe, expect, it } from "vitest";
import {
  approveComplianceCase,
  canReadContent,
  closeComplianceCase,
  openComplianceCase,
  type ComplianceCase,
  type ComplianceResourceRef,
} from "./compliance-case";

const NOW = new Date("2026-09-17T12:00:00.000Z");

function baseCase(overrides: Partial<Parameters<typeof openComplianceCase>[0]> = {}): ComplianceCase {
  return openComplianceCase({
    id: "case-1",
    externalRef: "meta-complaint-123",
    category: "user_complaint",
    accountId: "tenant-1",
    scope: { scopeType: "message_ids", scopeValue: { messageIds: ["m1", "m2"] } },
    openedBy: "opener-user",
    reason: "Meta raised a user complaint",
    ...overrides,
  });
}

describe("compliance cases — SUPER_ADMIN_CONSOLE.md §7", () => {
  describe("openComplianceCase", () => {
    it("a freshly opened case is unapproved and grants nothing", () => {
      const case_ = baseCase();
      expect(case_.approvedBy).toBeNull();
      expect(case_.expiresAt).toBeNull();

      const ref: ComplianceResourceRef = { type: "message_ids", messageId: "m1" };
      expect(canReadContent(case_, ref, NOW)).toBe(false);
    });
  });

  describe("approveComplianceCase — two-person rule", () => {
    it("REJECTS when the approver is the case's opener", () => {
      const case_ = baseCase({ openedBy: "same-user" });
      const result = approveComplianceCase(case_, "same-user", { now: NOW });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("succeeds when approver differs from opener, setting approvedBy/approvedAt/expiresAt", () => {
      const case_ = baseCase({ openedBy: "opener-user" });
      const result = approveComplianceCase(case_, "approver-user", { now: NOW });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.approvedBy).toBe("approver-user");
        expect(result.value.approvedAt).toBe(NOW.toISOString());
        expect(result.value.expiresAt).not.toBeNull();
      }
    });

    it("defaults TTL to 7 days and clamps a requested TTL to the 30-day max", () => {
      const case_ = baseCase();
      const defaultTtl = approveComplianceCase(case_, "approver-user", { now: NOW });
      const clampedTtl = approveComplianceCase(case_, "approver-user", { now: NOW, ttlDays: 9999 });
      expect(defaultTtl.ok && clampedTtl.ok).toBe(true);
      if (defaultTtl.ok && clampedTtl.ok) {
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
        expect(new Date(defaultTtl.value.expiresAt as string).getTime() - NOW.getTime()).toBe(sevenDaysMs);
        expect(new Date(clampedTtl.value.expiresAt as string).getTime() - NOW.getTime()).toBe(thirtyDaysMs);
      }
    });

    it("rejects approving an already-closed case", () => {
      const closed = closeComplianceCase(baseCase(), "closer-user", "resolved", NOW);
      const result = approveComplianceCase(closed, "approver-user", { now: NOW });
      expect(result.ok).toBe(false);
    });

    it("rejects approving an already-approved case", () => {
      const approvedOnce = approveComplianceCase(baseCase(), "approver-user", { now: NOW });
      expect(approvedOnce.ok).toBe(true);
      if (!approvedOnce.ok) return;
      const approvedTwice = approveComplianceCase(approvedOnce.value, "second-approver", { now: NOW });
      expect(approvedTwice.ok).toBe(false);
      if (!approvedTwice.ok) expect(approvedTwice.error.code).toBe("CONFLICT");
    });
  });

  describe("canReadContent", () => {
    function approvedCase(): ComplianceCase {
      const result = approveComplianceCase(baseCase(), "approver-user", { now: NOW, ttlDays: 7 });
      if (!result.ok) throw new Error("expected approval to succeed");
      return result.value;
    }

    it("a case with no approvedBy grants nothing, even when read at a plausible in-scope resource", () => {
      const case_ = baseCase();
      const ref: ComplianceResourceRef = { type: "message_ids", messageId: "m1" };
      expect(canReadContent(case_, ref, NOW)).toBe(false);
    });

    it("approved + in-scope grants access", () => {
      const case_ = approvedCase();
      const ref: ComplianceResourceRef = { type: "message_ids", messageId: "m1" };
      expect(canReadContent(case_, ref, NOW)).toBe(true);
    });

    it("approved but out-of-scope (wrong message id) denies access", () => {
      const case_ = approvedCase();
      const ref: ComplianceResourceRef = { type: "message_ids", messageId: "not-in-scope" };
      expect(canReadContent(case_, ref, NOW)).toBe(false);
    });

    it("approved but wrong scope TYPE (e.g. a contact ref against a message_ids case) denies access", () => {
      const case_ = approvedCase();
      const ref: ComplianceResourceRef = { type: "contact", contactId: "c1" };
      expect(canReadContent(case_, ref, NOW)).toBe(false);
    });

    it("expired denies access even when closedAt is still null", () => {
      const case_ = approvedCase();
      expect(case_.closedAt).toBeNull();
      const wellAfterExpiry = new Date(new Date(case_.expiresAt as string).getTime() + 60_000);
      const ref: ComplianceResourceRef = { type: "message_ids", messageId: "m1" };
      expect(canReadContent(case_, ref, wellAfterExpiry)).toBe(false);
    });

    it("exactly at expiresAt is already denied (expiry boundary is exclusive of the expiry instant)", () => {
      const case_ = approvedCase();
      const ref: ComplianceResourceRef = { type: "message_ids", messageId: "m1" };
      const atExpiry = new Date(case_.expiresAt as string);
      expect(canReadContent(case_, ref, atExpiry)).toBe(false);
    });

    it("closed denies access even while still within the TTL window", () => {
      const approved = approvedCase();
      const closed = closeComplianceCase(approved, "closer-user", "resolved", NOW);
      const ref: ComplianceResourceRef = { type: "message_ids", messageId: "m1" };
      expect(canReadContent(closed, ref, NOW)).toBe(false);
    });

    it("contact scope: matches only the declared contactId", () => {
      const case_ = (() => {
        const opened = openComplianceCase({
          id: "case-2",
          externalRef: "meta-2",
          category: "quality_rating_investigation",
          accountId: "tenant-1",
          scope: { scopeType: "contact", scopeValue: { contactId: "contact-42" } },
          openedBy: "opener",
          reason: "quality review",
        });
        const approved = approveComplianceCase(opened, "approver", { now: NOW });
        if (!approved.ok) throw new Error("expected approval to succeed");
        return approved.value;
      })();
      expect(canReadContent(case_, { type: "contact", contactId: "contact-42" }, NOW)).toBe(true);
      expect(canReadContent(case_, { type: "contact", contactId: "someone-else" }, NOW)).toBe(false);
    });

    it("date_range scope: matches only within [from, to] inclusive", () => {
      const opened = openComplianceCase({
        id: "case-3",
        externalRef: "meta-3",
        category: "legal_request",
        accountId: "tenant-1",
        scope: {
          scopeType: "date_range",
          scopeValue: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T23:59:59.000Z" },
        },
        openedBy: "opener",
        reason: "law enforcement request",
      });
      const approved = approveComplianceCase(opened, "approver", { now: NOW });
      if (!approved.ok) throw new Error("expected approval to succeed");
      const case_ = approved.value;

      expect(canReadContent(case_, { type: "date_range", occurredAt: "2026-01-15T00:00:00.000Z" }, NOW)).toBe(
        true,
      );
      expect(canReadContent(case_, { type: "date_range", occurredAt: "2025-12-31T00:00:00.000Z" }, NOW)).toBe(
        false,
      );
      expect(canReadContent(case_, { type: "date_range", occurredAt: "2026-02-01T00:00:01.000Z" }, NOW)).toBe(
        false,
      );
    });
  });
});
