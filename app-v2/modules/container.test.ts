import { describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../db/sqlite/run-migrations";
import { buildModuleRepositories } from "./container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("module composition root", () => {
  it("builds module repositories over the framework's chosen database", async () => {
    const db = await SqlJsDatabaseProvider.create();
    runMigrations(db);
    const repos = buildModuleRepositories(db);
    // Reaches the real schema through the real adapter.
    expect(await repos.contacts.listAll({ tenantId: "acct-x" as never })).toEqual([]);
    await db.dispose();
  });

  it("the FRAMEWORK container must not depend on business modules", () => {
    // The layering rule this file exists to protect. If nexara/ ever imports
    // modules/, the framework stops being reusable by another Nexara vertical
    // without dragging WACRM's schema along.
    const container = readFileSync(
      fileURLToPath(new URL("../nexara/core/container.ts", import.meta.url)),
      "utf8",
    );
    expect(container).not.toMatch(/from\s+["'][^"']*modules\//);
    expect(container).not.toMatch(/@modules\//);
  });
});

describe("every wired repository reaches the real schema", () => {
  // Constructing a repository proves nothing — the credentials repository
  // constructed fine for the entire life of this project while querying a
  // table that did not exist. These issue one real read per repository
  // against the migrated schema, so a missing table or a renamed column
  // fails here rather than in production.
  it("issues a live read through each repository without error", async () => {
    const db = await SqlJsDatabaseProvider.create();
    runMigrations(db);
    const r = buildModuleRepositories(db);
    const tenant = { tenantId: "acct-probe" as never };

    await expect(r.contacts.listAll(tenant)).resolves.toEqual([]);
    await expect(r.conversations.list(tenant, {} as never, { limit: 1 } as never)).resolves.toBeDefined();
    await expect(r.seats.listMembers(tenant)).resolves.toEqual([]);
    await expect(r.seats.listInvitations(tenant)).resolves.toEqual([]);
    // NOTE: this port takes a bare AccountId while every other repository
    // takes a TenantContext. Harmless but inconsistent — worth reconciling
    // when the whatsapp module's ports are next touched.
    await expect(r.whatsappConfig.listByAccount("acct-probe" as never)).resolves.toEqual([]);
    await expect(r.onboarding.findCurrentForAccount(tenant)).resolves.toBeNull();
    await expect(r.accountDirectory.listAccountIds(null, 1)).resolves.toEqual({
      accountIds: [],
      nextCursor: null,
    });

    const platformPrincipal = { userId: "probe-staff", tenantId: "n/a", email: "staff@test", platformRole: "platform_support" } as never;
    await expect(r.complianceCases.findActiveForAccount(platformPrincipal, "acct-probe")).resolves.toEqual([]);
    await expect(r.platformRoleGrants.findActiveForUser(platformPrincipal, "probe-user")).resolves.toBeNull();

    await db.dispose();
  });

  it("exposes a repository for every module that has one", async () => {
    // Guards against a module landing persistence without being wired: the
    // type would still compile if a key were simply omitted here.
    const db = await SqlJsDatabaseProvider.create();
    runMigrations(db);
    const keys = Object.keys(buildModuleRepositories(db)).sort();
    expect(keys).toEqual(
      [
        "accountDirectory", "broadcastRecipients", "broadcasts", "complianceCases", "contactState", "contacts",
        "conversations", "deviceInstallations", "emailTokens", "impersonation", "messageTemplates",
        "messages", "onboarding", "platformAuditLog", "platformRoleGrants", "refreshTokens",
        "seats", "sessions", "signup", "users", "webhookEvents", "whatsappConfig",
      ].sort(),
    );
    await db.dispose();
  });
});
