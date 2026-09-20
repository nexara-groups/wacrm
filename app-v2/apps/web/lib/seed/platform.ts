/**
 * Demo data for the platform (super-admin) console — platform-role grants
 * for one demo staffer per tier, login credentials for them, and one
 * compliance case walked all the way through open -> approve (the
 * two-person rule, satisfied by two DIFFERENT demo admins) so the console
 * has something real to render instead of an always-empty screen.
 *
 * -----------------------------------------------------------------------
 * NOT WIRED — read before assuming this runs
 * -----------------------------------------------------------------------
 * Every other seeder (`seedContacts`, `seedTeam`, `seedConversations`,
 * `seedBroadcasts`, `seedUsers`) is invoked from exactly one place:
 * `lib/container.ts`'s `build()` (`SEEDERS` array + the separate
 * `seedUsers` call). This file is written to the same `Seeder`/credentials-
 * seeding shape so it drops in the same way, but `lib/container.ts` is on
 * this task's DO-NOT-MODIFY list (HARD RULE 8) — so nothing calls this file
 * yet, and `npx next dev` today has NO platform-role grant in its demo
 * database at all. Every login available through the running dev server
 * (`owner@demo.test`) is a plain tenant user with no platform role, which
 * is exactly what this task's verification step asked to be proven refused
 * — but it also means there is currently no way to prove the AUTHORIZED
 * path over real HTTP without this file being wired in. See the final
 * report for how that was verified instead (a direct integration test
 * against the real repositories + real route handlers).
 *
 * To wire it, once `lib/container.ts` is back in scope: add
 * `seedPlatformRoleGrants`/`seedComplianceCaseDemo` to `build()`'s
 * `SEEDERS`-style sequence (after `seedContacts`, so the demo case can
 * reference a real contact), and call `seedPlatformCredentials` alongside
 * the existing `seedUsers` call.
 *
 * -----------------------------------------------------------------------
 * The bootstrap principal
 * -----------------------------------------------------------------------
 * `PlatformRoleGrantPort.grant` enforces the two-person rule (grantor !==
 * grantee) but has no special case for "the very first grant" — in a real
 * deployment that first `platform_superadmin` is created outside the
 * normal grant flow (an operator running a one-off script against
 * production, the same way a first admin is usually bootstrapped). Seed
 * fixtures are the equivalent for this demo database: `SEED_BOOTSTRAP_
 * PRINCIPAL` below is a synthetic, non-loggable identity that exists only
 * to author fixture rows, never reachable through any route or login.
 */
import { randomUUID } from "node:crypto";
// PBKDF2 via WebCrypto, not bcryptjs: the auth provider verifies with
// `verifyPassword`, which only understands the `pbkdf2-sha256$...` format, so
// a bcrypt hash here would seed an account that can never log in. It is also
// the only form that runs inside Cloudflare Workers' CPU budget.
import { hashPassword } from "@modules/identity/domain/token-hashing";
import { WORKERS_FREE_TIER_ITERATIONS } from "@nexara/core/auth/providers/jwt-auth-provider";
import type { CredentialsRepository } from "@nexara/core/auth";
import type { TenantContext } from "@nexara/core/context";
import type { VerifiedPlatformPrincipal } from "@nexara/core/rbac";
import type { SeedContext } from "./types";

export const DEMO_PLATFORM_SUPPORT_EMAIL = "support@platform.nexara.test";
export const DEMO_PLATFORM_ADMIN_A_EMAIL = "admin-a@platform.nexara.test";
export const DEMO_PLATFORM_ADMIN_B_EMAIL = "admin-b@platform.nexara.test";
/** Not a secret worth protecting — seed data for a local in-memory demo database, same posture as `seedUsers`'s DEMO_LOGIN_PASSWORD. */
export const DEMO_PLATFORM_PASSWORD = "Nexara-Platform-2026!";

const SEED_BOOTSTRAP_PRINCIPAL: VerifiedPlatformPrincipal = {
  userId: "seed-bootstrap",
  tenantId: "n/a",
  email: "seed-bootstrap@nexara.internal",
  platformRole: "platform_superadmin",
};

export interface SeedPlatformResult {
  readonly supportUserId: string;
  /** Opens the demo compliance case. */
  readonly adminAUserId: string;
  /** Approves it — a DIFFERENT user, so the two-person rule is satisfied, not bypassed. */
  readonly adminBUserId: string;
}

/** One demo staffer per tier, so the console has every tier to show. Grant is an upsert (repository's own `on conflict`), so this is safe to call more than once against the same DB. */
export async function seedPlatformRoleGrants(ctx: SeedContext): Promise<SeedPlatformResult> {
  const { repositories } = ctx;
  const supportUserId = randomUUID();
  const adminAUserId = randomUUID();
  const adminBUserId = randomUUID();

  await repositories.platformRoleGrants.grant(
    SEED_BOOTSTRAP_PRINCIPAL,
    supportUserId,
    "platform_support",
    "seed fixture — platform_support demo staff",
  );
  await repositories.platformRoleGrants.grant(
    SEED_BOOTSTRAP_PRINCIPAL,
    adminAUserId,
    "platform_admin",
    "seed fixture — platform_admin demo staff (opens the demo compliance case)",
  );
  await repositories.platformRoleGrants.grant(
    SEED_BOOTSTRAP_PRINCIPAL,
    adminBUserId,
    "platform_admin",
    "seed fixture — platform_admin demo staff (approves it — the 2-person-rule partner)",
  );

  return { supportUserId, adminAUserId, adminBUserId };
}

/**
 * Opens and approves one demo case, using the REAL repository calls (never
 * a direct insert) so the two-person rule and the TTL are exactly the ones
 * a real staffer would hit. Prefers scoping to a real seeded contact (via
 * `repositories.contacts.search`) when one exists, so the demo scope is
 * something the account detail screen could actually cross-reference —
 * falls back to a synthetic id when `seedContacts` has not run first.
 */
export async function seedComplianceCaseDemo(ctx: SeedContext, grants: SeedPlatformResult): Promise<void> {
  const { repositories, tenant } = ctx;

  const adminA: VerifiedPlatformPrincipal = {
    userId: grants.adminAUserId,
    tenantId: "n/a",
    email: DEMO_PLATFORM_ADMIN_A_EMAIL,
    platformRole: "platform_admin",
  };
  const adminB: VerifiedPlatformPrincipal = {
    userId: grants.adminBUserId,
    tenantId: "n/a",
    email: DEMO_PLATFORM_ADMIN_B_EMAIL,
    platformRole: "platform_admin",
  };

  const existingContacts = await repositories.contacts.search(tenant, {}, { page: 1, pageSize: 1 });
  const contactId = existingContacts.items[0]?.id ?? randomUUID();

  const case_ = await repositories.complianceCases.open(adminA, {
    id: randomUUID(),
    externalRef: "META-CASE-2026-0917",
    category: "user_complaint",
    accountId: tenant.tenantId,
    scope: { scopeType: "contact", scopeValue: { contactId } },
    reason:
      "Meta raised a user complaint about unsolicited messages to this contact; verifying opt-in " +
      "evidence and template usage before responding.",
  });

  // A SECOND, different platform_admin approves — proves the two-person
  // rule in the seed data itself, not just in a unit test.
  await repositories.complianceCases.approve(adminB, case_.id, 7);
}

export interface SeedPlatformCredentialsContext {
  readonly credentialsRepository: CredentialsRepository;
  readonly tenant: TenantContext;
  readonly now: string;
  readonly grants: SeedPlatformResult;
}

/**
 * Same pattern as `seedUsers` (lib/seed/users.ts) — writes through the real
 * `CredentialsRepository`, never a raw insert. `role: "member"` on each
 * credential is a placeholder TENANT role only (the `credentials.role`
 * column has a NOT NULL CHECK restricted to owner/admin/manager/member —
 * db/migrations/d1/0011_credentials.sql); it has nothing to do with the
 * platform role granted above, which lives entirely in `platform_admins`,
 * a separate table, per SUPER_ADMIN_CONSOLE.md §2's "different table,
 * different grant path". This IS a real gap worth naming: there is no
 * platform-only credential path (spec §5: "separate credential path from
 * tenant auth"), so a platform staffer in this demo also incidentally
 * looks like a tenant member with the placeholder role — see final report.
 */
export async function seedPlatformCredentials({
  credentialsRepository,
  tenant,
  now,
  grants,
}: SeedPlatformCredentialsContext): Promise<void> {
  const passwordHash = await hashPassword(DEMO_PLATFORM_PASSWORD, WORKERS_FREE_TIER_ITERATIONS);
  const entries: readonly [string, string][] = [
    [grants.supportUserId, DEMO_PLATFORM_SUPPORT_EMAIL],
    [grants.adminAUserId, DEMO_PLATFORM_ADMIN_A_EMAIL],
    [grants.adminBUserId, DEMO_PLATFORM_ADMIN_B_EMAIL],
  ];

  for (const [userId, email] of entries) {
    const existing = await credentialsRepository.findByEmail(tenant, email);
    if (existing) continue;
    await credentialsRepository.create(tenant, {
      userId,
      email,
      passwordHash,
      role: "member",
      verifiedAt: now,
    });
  }
}
