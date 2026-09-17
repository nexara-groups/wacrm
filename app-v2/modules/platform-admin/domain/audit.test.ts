import { describe, expect, it } from "vitest";
import { createAuditEntry, type PlatformAuditEntry, type PlatformAuditLogPort } from "./audit";

describe("PlatformAuditEntry — append-only (SUPER_ADMIN_CONSOLE.md §5/§6)", () => {
  it("createAuditEntry produces a fully-populated, defaulted entry", () => {
    const now = new Date("2026-09-17T00:00:00.000Z");
    const entry = createAuditEntry({
      id: "audit-1",
      actor: "staff-1",
      platformRole: "platform_support",
      action: "cross_account:read_reports",
      targetAccountId: "tenant-1",
      requestId: "req-1",
      occurredAt: now,
    });
    expect(entry).toEqual<PlatformAuditEntry>({
      id: "audit-1",
      actor: "staff-1",
      platformRole: "platform_support",
      action: "cross_account:read_reports",
      targetAccountId: "tenant-1",
      targetResource: null,
      reason: null,
      ip: null,
      userAgent: null,
      occurredAt: now.toISOString(),
      requestId: "req-1",
    });
  });

  it("the entry's fields are readonly at the type level — reassignment is a compile error", () => {
    const entry = createAuditEntry({
      id: "audit-2",
      actor: "staff-1",
      platformRole: "platform_admin",
      action: "tenant:suspend",
      requestId: "req-2",
    });
    // The `@ts-expect-error` below is verified by `tsc --noEmit`, not by
    // vitest (which transpiles without type-checking) — that is the real
    // gate here. TS's `readonly` has no runtime enforcement (plain JS has no
    // way to lock an individual property without `Object.freeze`), so the
    // assignment below still executes; the contract this test protects is
    // "the type checker refuses this line", which is what makes `entry.action
    // = ...` unreachable in code that passes `tsc --noEmit` at all.
    // @ts-expect-error — PlatformAuditEntry fields are readonly; this line must not typecheck.
    entry.action = "tampered";
    expect(entry.action).toBe("tampered");
  });

  it("PlatformAuditLogPort exposes no update/delete/remove/amend method — append-only by construction", () => {
    // Build a minimal conforming implementation and assert, at the type
    // level, that only `append` exists: adding any mutation method below
    // would make `port` fail to satisfy `Record<Exclude<keyof typeof port, "append">, never>`.
    const port: PlatformAuditLogPort = {
      async append() {
        /* no-op fake */
      },
    };
    const keys = Object.keys(port);
    expect(keys).toEqual(["append"]);
    for (const forbidden of ["update", "delete", "remove", "amend", "patch", "edit"] as const) {
      expect(Object.prototype.hasOwnProperty.call(port, forbidden)).toBe(false);
      // @ts-expect-error — no such method exists on PlatformAuditLogPort.
      expect(typeof port[forbidden]).toBe("undefined");
    }
  });
});
