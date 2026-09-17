import { describe, expect, it } from "vitest";
import { ROLE_RANK, roleAtLeast, type Role } from "./roles";
import {
  PLATFORM_ROLE_RANK,
  PLATFORM_ROLES,
  isPlatformRole,
  isVerifiedPlatformPrincipal,
  platformRoleAtLeast,
  type PlatformPrincipal,
  type PlatformRole,
} from "./platform-roles";

describe("platform roles are an orthogonal axis — SUPER_ADMIN_CONSOLE.md §2", () => {
  it("PLATFORM_ROLES and ROLES share no values", () => {
    const roles = new Set<string>(Object.keys(ROLE_RANK));
    for (const platformRole of PLATFORM_ROLES) {
      expect(roles.has(platformRole)).toBe(false);
    }
  });

  it("ROLE_RANK has no platform-role keys, and PLATFORM_ROLE_RANK has no tenant-role keys", () => {
    for (const platformRole of PLATFORM_ROLES) {
      expect(Object.prototype.hasOwnProperty.call(ROLE_RANK, platformRole)).toBe(false);
    }
    const tenantRoles: readonly Role[] = ["owner", "admin", "manager", "member"];
    for (const role of tenantRoles) {
      expect(Object.prototype.hasOwnProperty.call(PLATFORM_ROLE_RANK, role)).toBe(false);
    }
  });

  it("a platform role never satisfies a tenant-role check (roleAtLeast)", () => {
    // A real call site cannot even construct this — PlatformRole is not
    // assignable to Role — so we simulate untrusted/miscast input the way
    // e.g. a value read from a token claim might arrive at runtime.
    for (const platformRole of PLATFORM_ROLES) {
      expect(roleAtLeast(platformRole as unknown as Role, "member")).toBe(false);
      expect(roleAtLeast(platformRole as unknown as Role, "owner")).toBe(false);
    }
  });

  it("a tenant role never satisfies a platform-role check (platformRoleAtLeast) — the reverse direction", () => {
    const tenantRoles: readonly Role[] = ["owner", "admin", "manager", "member"];
    for (const role of tenantRoles) {
      expect(platformRoleAtLeast(role as unknown as PlatformRole, "platform_support")).toBe(false);
      expect(platformRoleAtLeast(role as unknown as PlatformRole, "platform_superadmin")).toBe(false);
    }
  });

  it("owner (highest tenant rank) still does not satisfy the lowest platform tier", () => {
    expect(platformRoleAtLeast("owner" as unknown as PlatformRole, "platform_support")).toBe(false);
  });

  it("platform_superadmin (highest platform rank) still does not satisfy the lowest tenant role", () => {
    expect(roleAtLeast("platform_superadmin" as unknown as Role, "member")).toBe(false);
  });

  it("tiers are strictly cumulative: superadmin >= admin >= support, in rank order", () => {
    expect(PLATFORM_ROLE_RANK.platform_superadmin).toBeGreaterThan(PLATFORM_ROLE_RANK.platform_admin);
    expect(PLATFORM_ROLE_RANK.platform_admin).toBeGreaterThan(PLATFORM_ROLE_RANK.platform_support);

    expect(platformRoleAtLeast("platform_superadmin", "platform_admin")).toBe(true);
    expect(platformRoleAtLeast("platform_superadmin", "platform_support")).toBe(true);
    expect(platformRoleAtLeast("platform_admin", "platform_support")).toBe(true);
    expect(platformRoleAtLeast("platform_support", "platform_admin")).toBe(false);
    expect(platformRoleAtLeast("platform_admin", "platform_superadmin")).toBe(false);
  });

  it("isPlatformRole rejects tenant role strings and arbitrary input", () => {
    expect(isPlatformRole("owner")).toBe(false);
    expect(isPlatformRole("platform_admin")).toBe(true);
    expect(isPlatformRole("bogus")).toBe(false);
    expect(isPlatformRole(42)).toBe(false);
  });

  it("a PlatformPrincipal may hold both a tenantRole and a platformRole without either leaking", () => {
    const staffer: PlatformPrincipal = {
      userId: "u1",
      tenantId: "t1",
      email: "staff@nexara.example",
      tenantRole: "owner", // owns a demo account
      platformRole: "platform_support", // also Nexara staff
    };
    expect(roleAtLeast(staffer.tenantRole as Role, "owner")).toBe(true);
    expect(platformRoleAtLeast(staffer.platformRole as PlatformRole, "platform_support")).toBe(true);
    // Neither axis is satisfied by the other's value.
    expect(roleAtLeast(staffer.platformRole as unknown as Role, "member")).toBe(false);
    expect(platformRoleAtLeast(staffer.tenantRole as unknown as PlatformRole, "platform_support")).toBe(
      false,
    );
  });

  it("isVerifiedPlatformPrincipal narrows only when platformRole is present and valid", () => {
    const withRole: PlatformPrincipal = { userId: "u1", tenantId: "t1", email: "a@b.com", platformRole: "platform_admin" };
    const withoutRole: PlatformPrincipal = { userId: "u2", tenantId: "t1", email: "c@d.com" };
    expect(isVerifiedPlatformPrincipal(withRole)).toBe(true);
    expect(isVerifiedPlatformPrincipal(withoutRole)).toBe(false);
  });
});
