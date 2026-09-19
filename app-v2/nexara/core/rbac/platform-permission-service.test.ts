import { describe, expect, it } from "vitest";
import {
  PLATFORM_CAPABILITIES,
  PLATFORM_ROLE_CAPABILITIES,
  PlatformPermissionService,
  isPlatformCapability,
  type PlatformCapability,
} from "./platform-permission-service";
import type { VerifiedPlatformPrincipal } from "./platform-roles";

function principal(platformRole: VerifiedPlatformPrincipal["platformRole"]): VerifiedPlatformPrincipal {
  return { userId: "u1", tenantId: "t1", email: "staff@nexara.example", platformRole };
}

describe("PlatformPermissionService — SUPER_ADMIN_CONSOLE.md §2 gating table", () => {
  const svc = new PlatformPermissionService();

  describe("cross-account oversight is NOT gated — every tier, every account", () => {
    const oversightCapabilities: readonly PlatformCapability[] = [
      "cross_account:read_reports",
      "cross_account:read_metadata",
      "cross_account:read_activity",
      "cross_account:read_billing_state",
      "cross_account:read_delivery_health",
    ];

    it.each(oversightCapabilities)("%s is granted to platform_support", (capability) => {
      expect(svc.can("platform_support", capability)).toBe(true);
    });

    it.each(oversightCapabilities)("%s is granted to platform_admin", (capability) => {
      expect(svc.can("platform_admin", capability)).toBe(true);
    });

    it.each(oversightCapabilities)("%s is granted to platform_superadmin", (capability) => {
      expect(svc.can("platform_superadmin", capability)).toBe(true);
    });
  });

  describe("mutating tenant data / impersonation / opening a case — platform_admin+", () => {
    const adminCapabilities: readonly PlatformCapability[] = [
      "tenant:adjust_credit",
      "tenant:suspend",
      "tenant:reactivate",
      "tenant:clear_suppression",
      "tenant:requeue",
      "tenant:impersonate",
      "compliance_case:open",
    ];

    it.each(adminCapabilities)("%s is denied to platform_support", (capability) => {
      expect(svc.can("platform_support", capability)).toBe(false);
    });

    it.each(adminCapabilities)("%s is granted to platform_admin", (capability) => {
      expect(svc.can("platform_admin", capability)).toBe(true);
    });

    it.each(adminCapabilities)("%s is granted to platform_superadmin", (capability) => {
      expect(svc.can("platform_superadmin", capability)).toBe(true);
    });
  });

  describe("granting platform roles / platform config — platform_superadmin only", () => {
    const superadminOnly: readonly PlatformCapability[] = [
      "platform_role:grant",
      "platform_role:revoke",
      "platform_config:manage",
    ];

    it.each(superadminOnly)("%s is denied to platform_support", (capability) => {
      expect(svc.can("platform_support", capability)).toBe(false);
    });

    it.each(superadminOnly)("%s is denied to platform_admin", (capability) => {
      expect(svc.can("platform_admin", capability)).toBe(false);
    });

    it.each(superadminOnly)("%s is granted to platform_superadmin", (capability) => {
      expect(svc.can("platform_superadmin", capability)).toBe(true);
    });
  });

  describe("tiers are cumulative", () => {
    it("every platform_support capability is also a platform_admin capability", () => {
      for (const cap of PLATFORM_ROLE_CAPABILITIES.platform_support) {
        expect(PLATFORM_ROLE_CAPABILITIES.platform_admin.has(cap)).toBe(true);
      }
    });

    it("every platform_admin capability is also a platform_superadmin capability", () => {
      for (const cap of PLATFORM_ROLE_CAPABILITIES.platform_admin) {
        expect(PLATFORM_ROLE_CAPABILITIES.platform_superadmin.has(cap)).toBe(true);
      }
    });

    it("platform_superadmin holds strictly more capabilities than platform_admin, which holds strictly more than platform_support", () => {
      expect(PLATFORM_ROLE_CAPABILITIES.platform_superadmin.size).toBeGreaterThan(
        PLATFORM_ROLE_CAPABILITIES.platform_admin.size,
      );
      expect(PLATFORM_ROLE_CAPABILITIES.platform_admin.size).toBeGreaterThan(
        PLATFORM_ROLE_CAPABILITIES.platform_support.size,
      );
    });

    it("nothing is withheld from the top tier: platform_superadmin holds every defined capability", () => {
      for (const cap of PLATFORM_CAPABILITIES) {
        expect(svc.can("platform_superadmin", cap)).toBe(true);
      }
    });
  });

  describe("no tier grants general message-content browsing — structurally, not just unchecked", () => {
    it("there is no content-read capability in the closed PLATFORM_CAPABILITIES set, at all", () => {
      const suspiciousNames = [
        "message_content:read",
        "message:read",
        "content:read",
        "inbox:browse",
        "conversation:read",
        "messages:browse",
      ];
      for (const name of suspiciousNames) {
        expect((PLATFORM_CAPABILITIES as readonly string[]).includes(name)).toBe(false);
        expect(isPlatformCapability(name)).toBe(false);
      }
    });

    it("not even platform_superadmin can be asked for a content-browsing capability, because none exists to ask for", () => {
      // isPlatformCapability is the runtime gate a caller would have to pass
      // before `can`/`canForPrincipal` would even accept the string — a
      // forged capability string is rejected before role gating runs.
      expect(isPlatformCapability("message_content:read")).toBe(false);
    });

    it("canForPrincipal on a verified superadmin still cannot express content access", () => {
      const superadmin = principal("platform_superadmin");
      // @ts-expect-error — "message_content:read" is not a valid PlatformCapability; this must not compile.
      const attempted: boolean = svc.canForPrincipal(superadmin, "message_content:read");
      expect(attempted).toBe(false);
    });
  });

  describe("canForPrincipal / assertCanForPrincipal", () => {
    it("delegates to can() using the principal's verified platformRole", () => {
      expect(svc.canForPrincipal(principal("platform_admin"), "tenant:suspend")).toBe(true);
      expect(svc.canForPrincipal(principal("platform_support"), "tenant:suspend")).toBe(false);
    });

    it("assertCanForPrincipal throws AppError FORBIDDEN when the capability is missing", () => {
      expect(() => svc.assertCanForPrincipal(principal("platform_support"), "tenant:suspend")).toThrow(
        /lacks capability/,
      );
    });

    it("assertCanForPrincipal does not throw when the capability is held", () => {
      expect(() => svc.assertCanForPrincipal(principal("platform_admin"), "tenant:suspend")).not.toThrow();
    });
  });
});
