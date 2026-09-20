import { beforeEach, describe, expect, it } from "vitest";
import type { VerifiedPlatformPrincipal } from "@nexara/core/rbac";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlPlatformAuditLogRepository } from "./audit-log-repository";
import { SqlPlatformRoleGrantRepository } from "./platform-role-grant-repository";

const SUPERADMIN: VerifiedPlatformPrincipal = {
  userId: "staff-superadmin",
  tenantId: "n/a",
  email: "superadmin@nexara.test",
  platformRole: "platform_superadmin",
};

let db: SqlJsDatabaseProvider;
let repo: SqlPlatformRoleGrantRepository;
let auditLog: SqlPlatformAuditLogRepository;

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  repo = new SqlPlatformRoleGrantRepository(db);
  auditLog = new SqlPlatformAuditLogRepository(db);
});

describe("SqlPlatformRoleGrantRepository — real schema (platform_admins)", () => {
  it("grant persists a row readable via findActiveForUser", async () => {
    const grant = await repo.grant(SUPERADMIN, "new-staff", "platform_support", "onboarding new support hire");
    expect(grant).toMatchObject({
      userId: "new-staff",
      platformRole: "platform_support",
      grantedBy: "staff-superadmin",
      revokedAt: null,
    });

    const found = await repo.findActiveForUser(SUPERADMIN, "new-staff");
    expect(found).toEqual(grant);
  });

  it("2-person rule: REJECTS a self-grant before writing anything", async () => {
    await expect(
      repo.grant(SUPERADMIN, "staff-superadmin", "platform_admin", "trying to self-grant"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Nothing was written — not the grant, not an audit entry for it.
    expect(await repo.findActiveForUser(SUPERADMIN, "staff-superadmin")).toBeNull();
  });

  it("revoke sets revoked_at so findActiveForUser stops returning the grant", async () => {
    await repo.grant(SUPERADMIN, "staff-b", "platform_admin", "grant for revoke test");
    expect(await repo.findActiveForUser(SUPERADMIN, "staff-b")).not.toBeNull();

    await repo.revoke(SUPERADMIN, "staff-b", "role no longer needed");
    expect(await repo.findActiveForUser(SUPERADMIN, "staff-b")).toBeNull();
  });

  it("re-granting after revocation clears revoked_at and updates the role (upsert on user_id)", async () => {
    await repo.grant(SUPERADMIN, "staff-c", "platform_support", "initial grant");
    await repo.revoke(SUPERADMIN, "staff-c", "temporary revoke");
    expect(await repo.findActiveForUser(SUPERADMIN, "staff-c")).toBeNull();

    const regrant = await repo.grant(SUPERADMIN, "staff-c", "platform_admin", "re-grant with higher tier");
    expect(regrant.platformRole).toBe("platform_admin");
    expect(regrant.revokedAt).toBeNull();
    expect(await repo.findActiveForUser(SUPERADMIN, "staff-c")).toEqual(regrant);
  });

  it("every grant/revoke writes an audit entry in the SAME batch as the mutation (HARD RULE 3)", async () => {
    await repo.grant(SUPERADMIN, "staff-d", "platform_support", "audited grant");
    const afterGrant = await auditLog.listAll();
    expect(afterGrant.some((e) => e.action === "platform_role:grant" && e.targetResource === "staff-d")).toBe(true);

    await repo.revoke(SUPERADMIN, "staff-d", "audited revoke");
    const afterRevoke = await auditLog.listAll();
    expect(afterRevoke.some((e) => e.action === "platform_role:revoke" && e.targetResource === "staff-d")).toBe(true);
  });

  it("findActiveForUser returns null and still audits the read for a user with no grant", async () => {
    expect(await repo.findActiveForUser(SUPERADMIN, "nobody")).toBeNull();
    const audited = await auditLog.listAll();
    expect(audited.some((e) => e.action === "platform_role:find_active_for_user" && e.targetResource === "nobody")).toBe(
      true,
    );
  });
});
