/**
 * Integration coverage for the platform console's security seam.
 *
 * WHY THIS TEST EXISTS INSTEAD OF (ALSO) HITTING THE ROUTES OVER HTTP:
 * `getCurrentAuth()`/`getPlatformPrincipal()`/`requirePlatformPrincipal()`
 * call `next/headers`'s `cookies()`, which only works inside an actual
 * Next.js request — calling it from a plain test throws. And
 * `lib/seed/platform.ts` (this task's seeder) is NOT wired into
 * `lib/container.ts` (out of scope to edit — see that file's own header),
 * so `npx next dev` has no platform-role grant in its demo database at
 * all; there is currently no way to log in as a platform user over real
 * HTTP. See the delivery report for both gaps in full.
 *
 * What CAN be, and is, proven here against the REAL repositories (no
 * mocks, no re-implemented logic): `resolvePlatformPrincipalForUser` — the
 * exact function every route calls — correctly refuses a user with no
 * grant, resolves the GRANTED role (never a claimed one) for a user who
 * has one, and refuses again the moment that grant is revoked. And, using
 * this task's own seed helpers, that a platform_admin who opens a case
 * cannot approve their own (the two-person rule, surfaced exactly the way
 * `app/api/platform/compliance-cases/[caseId]/approve/route.ts` calls it),
 * while a different platform_admin can.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { buildModuleRepositories, type ModuleRepositories } from "@modules/container";
import type { VerifiedPlatformPrincipal } from "@nexara/core/rbac";
import { AppError } from "@shared/errors";
import { resolvePlatformPrincipalForUser, requirePlatformTier } from "./platform-principal";
import { seedComplianceCaseDemo, seedPlatformRoleGrants } from "./seed/platform";
import type { SeedContext } from "./seed/types";

const TEST_BOOTSTRAP: VerifiedPlatformPrincipal = {
  userId: "test-seed-bootstrap",
  tenantId: "n/a",
  email: "bootstrap@nexara.internal",
  platformRole: "platform_superadmin",
};

describe("resolvePlatformPrincipalForUser — the platform console's ONE security seam", () => {
  let repositories: ModuleRepositories;

  beforeEach(async () => {
    const db = await SqlJsDatabaseProvider.create();
    runMigrations(db);
    repositories = buildModuleRepositories(db);
  });

  it("REFUSES a user with no platform-role grant — proves what owner@demo.test hits on every platform route", async () => {
    const result = await resolvePlatformPrincipalForUser(
      repositories,
      "some-tenant-owner-id",
      "demo-tenant-id",
      "owner@demo.test",
    );
    expect(result).toBeNull();
  });

  it("resolves the GRANTED role for a user who has an active grant — never a client-claimed one", async () => {
    const staffId = randomUUID();
    await repositories.platformRoleGrants.grant(TEST_BOOTSTRAP, staffId, "platform_admin", "test grant");

    const result = await resolvePlatformPrincipalForUser(repositories, staffId, "n/a", "staff@nexara.test");

    expect(result).toEqual({
      userId: staffId,
      tenantId: "n/a",
      email: "staff@nexara.test",
      platformRole: "platform_admin",
    });
  });

  it("REFUSES again the instant the grant is revoked", async () => {
    const staffId = randomUUID();
    await repositories.platformRoleGrants.grant(TEST_BOOTSTRAP, staffId, "platform_support", "test grant");
    await repositories.platformRoleGrants.revoke(TEST_BOOTSTRAP, staffId, "test revoke");

    const result = await resolvePlatformPrincipalForUser(repositories, staffId, "n/a", "staff@nexara.test");
    expect(result).toBeNull();
  });
});

describe("requirePlatformTier — the platform_admin+ gate approve/close routes use", () => {
  it("throws FORBIDDEN for a platform_support principal on a platform_admin+ action", () => {
    const support: VerifiedPlatformPrincipal = {
      userId: "u1",
      tenantId: "n/a",
      email: "support@nexara.test",
      platformRole: "platform_support",
    };
    expect(() => requirePlatformTier(support, "platform_admin")).toThrow(AppError);
    try {
      requirePlatformTier(support, "platform_admin");
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).code).toBe("FORBIDDEN");
    }
  });

  it("allows platform_admin and platform_superadmin through the platform_admin+ gate", () => {
    const admin: VerifiedPlatformPrincipal = { userId: "u2", tenantId: "n/a", email: "a@nexara.test", platformRole: "platform_admin" };
    const superadmin: VerifiedPlatformPrincipal = { userId: "u3", tenantId: "n/a", email: "s@nexara.test", platformRole: "platform_superadmin" };
    expect(() => requirePlatformTier(admin, "platform_admin")).not.toThrow();
    expect(() => requirePlatformTier(superadmin, "platform_admin")).not.toThrow();
  });
});

describe("compliance-case approval end-to-end via this task's own seed helpers", () => {
  let repositories: ModuleRepositories;
  let ctx: SeedContext;

  beforeEach(async () => {
    const db = await SqlJsDatabaseProvider.create();
    runMigrations(db);
    repositories = buildModuleRepositories(db);
    ctx = {
      repositories,
      tenant: { tenantId: randomUUID() as never },
      ownerUserId: randomUUID(),
      now: new Date().toISOString(),
      database: db,
    };
  });

  it("seedComplianceCaseDemo opens with one platform_admin and approves with a DIFFERENT one — the two-person rule satisfied, not bypassed", async () => {
    const grants = await seedPlatformRoleGrants(ctx);
    await seedComplianceCaseDemo(ctx, grants);

    const active = await repositories.complianceCases.findActiveForAccount(TEST_BOOTSTRAP, ctx.tenant.tenantId);
    expect(active).toHaveLength(1);
    expect(active[0]?.approvedBy).toBe(grants.adminBUserId);
    expect(active[0]?.openedBy).toBe(grants.adminAUserId);
    expect(active[0]?.approvedBy).not.toBe(active[0]?.openedBy);
    expect(active[0]?.expiresAt).not.toBeNull();
  });

  it("the SAME admin who opened a case is REFUSED approving it — exactly what /approve surfaces as 403", async () => {
    const grants = await seedPlatformRoleGrants(ctx);
    const adminA: VerifiedPlatformPrincipal = {
      userId: grants.adminAUserId,
      tenantId: "n/a",
      email: "admin-a@platform.nexara.test",
      platformRole: "platform_admin",
    };

    const case_ = await repositories.complianceCases.open(adminA, {
      id: randomUUID(),
      externalRef: "SELF-APPROVE-TEST",
      category: "user_complaint",
      accountId: ctx.tenant.tenantId,
      scope: { scopeType: "contact", scopeValue: { contactId: randomUUID() } },
      reason: "Testing that the opener cannot approve their own case.",
    });

    await expect(repositories.complianceCases.approve(adminA, case_.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // And it really did grant nothing — no standing access from the failed attempt.
    const reloaded = await repositories.complianceCases.findById(TEST_BOOTSTRAP, case_.id);
    expect(reloaded?.approvedBy).toBeNull();
    expect(reloaded?.expiresAt).toBeNull();
  });
});
