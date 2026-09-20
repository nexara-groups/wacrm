/**
 * Demo login — owner@demo.test with a REAL, hashed password.
 *
 * GAP THIS WORKS AROUND (see lib/container.ts's docstring for the full
 * story): modules/identity's own `UserRepositoryPort`/`SqlUserRepository`
 * cannot persist a password hash at all — `users` (db/migrations/d1/
 * 0001_identity.sql) has no password column by design, and
 * `SqlUserRepository.create()`/`updatePasswordHash()` are documented
 * no-ops for that field. `IdentityService.login()` therefore can never
 * succeed for a real password against that table. Neither `modules/**`
 * nor `db/**` are mine to edit, so this slice authenticates through the
 * OTHER, already-fully-wired credentials track instead:
 * `nexara/core/auth`'s `JwtAuthProvider` + `SqlCredentialsRepository`,
 * backed by the real `credentials` table (`db/migrations/d1/
 * 0011_credentials.sql`, which DOES have `password_hash`) — this is in
 * fact the framework's own default (`AUTH_PROVIDER=jwt` in
 * `nexara/core/container.ts`), just composed directly the way
 * `modules/container.ts`'s `buildModuleRepositories` bypasses the
 * Cloudflare-bound `Services` container for this dev harness.
 *
 * This seeder writes the one demo credential through the REAL
 * `CredentialsRepository` — never a raw insert into `credentials`.
 */
// PBKDF2 via WebCrypto, not bcryptjs: the auth provider verifies with
// `verifyPassword`, which only understands the `pbkdf2-sha256$...` format, so
// a bcrypt hash here would seed an account that can never log in. It is also
// the only form that runs inside Cloudflare Workers' CPU budget.
import { hashPassword } from "@modules/identity/domain/token-hashing";
import { WORKERS_FREE_TIER_ITERATIONS } from "@nexara/core/auth/providers/jwt-auth-provider";
import type { CredentialsRepository } from "@nexara/core/auth";
import type { TenantContext } from "@nexara/core/context";

export const DEMO_LOGIN_EMAIL = "owner@demo.test";
/** Not a secret worth protecting — this is seed data for a local in-memory demo database. */
export const DEMO_LOGIN_PASSWORD = "Wacrm-Demo-2026!";

export interface SeedUsersContext {
  readonly credentialsRepository: CredentialsRepository;
  readonly tenant: TenantContext;
  /** The `users` row this credential authenticates — see lib/container.ts's `build()`. */
  readonly ownerUserId: string;
  readonly now: string;
}

export async function seedUsers({
  credentialsRepository,
  tenant,
  ownerUserId,
  now,
}: SeedUsersContext): Promise<void> {
  const existing = await credentialsRepository.findByEmail(tenant, DEMO_LOGIN_EMAIL);
  if (existing) return;

  const passwordHash = await hashPassword(DEMO_LOGIN_PASSWORD, WORKERS_FREE_TIER_ITERATIONS);
  await credentialsRepository.create(tenant, {
    userId: ownerUserId,
    email: DEMO_LOGIN_EMAIL,
    passwordHash,
    role: "owner",
    // Pre-verified: this is seed data for a demo account, not a real
    // signup — there is no inbox to click a verification link from.
    verifiedAt: now,
  });
}
