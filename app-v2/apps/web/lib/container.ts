/**
 * Server-side composition root for the web app.
 *
 * Builds the module repositories ONCE per process, backed by sql.js +
 * `runMigrations` — the same dev-harness wiring as `dev/server.ts`, reused
 * rather than reimplemented. The production datastore is still undecided
 * (see DATABASE_DECISION.md at the repo root); nothing here may be treated
 * as a production adapter.
 *
 * Demo data comes from `lib/seed/*`, one module per vertical slice, each
 * writing through the real repositories — never a parallel copy of the data.
 * The seeder list below is the only place that knows all of them, so a slice
 * can be filled in without editing this file.
 *
 * The singleton is cached on `globalThis` (not just a module-level variable)
 * so Next.js dev-mode module reloads (Fast Refresh re-evaluating this file)
 * can't spin up a second in-memory database mid-session.
 *
 * -----------------------------------------------------------------------
 * AUTH — why this slice does not build an `IdentityService`
 * -----------------------------------------------------------------------
 * `modules/identity/application/identity-service.ts` is the module the AUTH
 * task pointed at, and it IS fully implemented — but its `login()` depends
 * on `UserRepositoryPort.passwordHash`, and `SqlUserRepository`
 * (modules/identity/infrastructure/user-repository.ts) documents, in its own
 * header, that it cannot persist that field: `users`
 * (db/migrations/d1/0001_identity.sql) has no password column by design,
 * so `create()` silently drops `passwordHash` and every read comes back a
 * sentinel (`NO_PASSWORD_COLUMN`) that can never match a real hash. Every
 * call to `IdentityService.login()` would therefore fail for every user,
 * always — not a quality gap, a structural one. Fixing it would mean either
 * a migration (`db/**`) or rewriting `SqlUserRepository`
 * (`modules/identity/infrastructure/**`) to read/write a different table —
 * both off limits to this task.
 *
 * Per the task's own rule ("missing port method? do not add one, do not
 * write SQL — build what you can and report the gap"), this container
 * builds real password login on the OTHER auth track that already exists
 * and already works end to end: `nexara/core/auth`'s `JwtAuthProvider` over
 * `SqlCredentialsRepository`, backed by the `credentials` table
 * (db/migrations/d1/0011_credentials.sql — password_hash and all). That is
 * in fact the framework's own default (`AUTH_PROVIDER=jwt` in
 * `nexara/core/container.ts`); this just composes the same two classes
 * directly against the sql.js provider, the same way
 * `modules/container.ts`'s `buildModuleRepositories` bypasses the
 * Cloudflare-bound `Services` container for this dev harness.
 */
import { randomUUID } from "node:crypto";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
// The real migration runner, not a copy: db/sqlite/run-migrations.ts no
// longer uses the `new URL(..., import.meta.url)` form that Turbopack
// special-cases, so it bundles cleanly now.
import { runMigrations } from "../../../db/sqlite/run-migrations";
import {
  D1DatabaseProvider,
  type D1DatabaseBinding,
} from "@nexara/core/database/providers/d1-database-provider";
import { buildModuleRepositories, type ModuleRepositories } from "@modules/container";
import { JwtAuthProvider } from "@nexara/core/auth/providers/jwt-auth-provider";
import { SqlCredentialsRepository } from "@nexara/infrastructure";
import type { CredentialsAuthProvider, CredentialsRepository } from "@nexara/core/auth";
import { PermissionService } from "@nexara/core/rbac";
import type { TenantContext } from "@nexara/core/context";
import { AppError } from "@shared/errors";
import type { TenantId } from "@shared/types";
import { seedContacts } from "./seed/contacts";
import { seedConversations } from "./seed/conversations";
import { seedBroadcasts } from "./seed/broadcasts";
import { seedTeam } from "./seed/team";
import { seedWhatsApp } from "./seed/whatsapp";
import { seedUsers } from "./seed/users";
import {
  seedComplianceCaseDemo,
  seedPlatformCredentials,
  seedPlatformRoleGrants,
} from "./seed/platform";
import type { Seeder } from "./seed/types";
import { getCurrentAuth } from "./session";

/** Order matters: later seeders may reference rows earlier ones created. */
const SEEDERS: readonly Seeder[] = [seedContacts, seedWhatsApp, seedTeam, seedConversations, seedBroadcasts];

const AUTH_ISSUER = "wacrm-web";
const AUTH_AUDIENCE = "wacrm-web-clients";
/** >= 32 bytes, as `JwtAuthProvider` requires. Override with a real secret in any deployed environment. */
/**
 * The JWT signing secret. A silent fallback here would be a forged-session
 * vulnerability: this string is in a public repository, so anyone could
 * mint a token for any tenant against a production deploy that simply
 * forgot to set the variable. The failure has to be loud and at startup,
 * not a quiet downgrade to a secret everybody knows.
 */
function resolveAuthSecret(): string {
  const configured = process.env.AUTH_SECRET;
  if (configured !== undefined && configured.length > 0) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET is not set. Refusing to sign sessions with a known development secret — " +
        "set AUTH_SECRET to a high-entropy value before deploying.",
    );
  }
  return "dev-only-wacrm-web-signing-secret-override-in-prod";
}

const AUTH_SECRET = resolveAuthSecret();

/**
 * Process-wide services that do NOT depend on the current request: the
 * repositories, and the auth provider used to turn a session cookie into a
 * user. Not tenant-scoped by itself — `getContainer()` below is.
 */
export interface BaseServices {
  readonly repositories: ModuleRepositories;
  readonly credentialsRepository: CredentialsRepository;
  readonly authProvider: CredentialsAuthProvider;
  /**
   * The seeded demo account/owner, present only in the dev/test sql.js
   * harness (see `isWorkersRuntime` below). On a real D1 deployment nothing
   * is seeded — every existing consumer resolves its tenant from the
   * session's JWT (`lib/session.ts`), never from these fields — so they are
   * `null` there rather than a fabricated id nothing should ever read.
   */
  readonly demoAccountId: TenantId | null;
  readonly demoOwnerUserId: string | null;
}

export interface AppContainer {
  readonly repositories: ModuleRepositories;
  readonly tenant: TenantContext;
  readonly ownerUserId: string;
}

/**
 * Structural Workers/Node split — NOT an env var, NOT a try/catch fallback.
 *
 * `navigator.userAgent === "Cloudflare-Workers"` is the runtime's own
 * self-identification (set by workerd itself, both under `wrangler dev` and
 * in a real deployment) and the detection method Cloudflare documents for
 * this exact purpose. Node (`next dev`, `vitest run`, `next build`) has no
 * `navigator` global before Node 21, and where it exists (Node 21+) its
 * `userAgent` is `"Node.js/<version>"` — never this string — so the two
 * environments can never be confused for one another.
 *
 * This is the ONLY switch between the two `BaseServices` builders below.
 * Nothing here inspects `NODE_ENV` or a feature flag: which storage engine
 * runs is a property of which JavaScript runtime the process IS, not a
 * setting that could be misconfigured to seed demo data into production D1.
 */
function isWorkersRuntime(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

/**
 * Reads a required Workers binding/var from `process.env`.
 *
 * OpenNext's worker entrypoint copies every string value off the Workers
 * `env` object onto `process.env` before any request is handled (see
 * `@opennextjs/cloudflare`'s `populateProcessEnv`), so plain `process.env`
 * reads are correct here, on the same terms `resolveAuthSecret` already
 * relies on for `AUTH_SECRET`. Fails closed — no default, ever.
 */
function requireWorkersEnv(name: string, why: string): string {
  const value = process.env[name];
  if (value !== undefined && value.length > 0) return value;
  throw new Error(`${name} is not set. ${why}`);
}

/**
 * Production path: Cloudflare Workers + D1, no seeding.
 *
 * `getCloudflareContext` (from `@opennextjs/cloudflare`) reads the `DB`
 * binding off the current request's Workers `env`. It is only ever called
 * from here, and only once per process: D1 bindings are fixed per Worker
 * deployment (not per-request), so caching the resulting provider on
 * `globalThis` (via `getBaseServices` below) for the isolate's lifetime is
 * correct, not a shortcut.
 *
 * There is deliberately no `runMigrations` call and no `SEEDERS` loop here.
 * `runMigrations` reads `.sql` files off disk (`node:fs`) — Workers has no
 * filesystem, and in any case migrations belong to `wrangler d1 migrations
 * apply`, run once by a human against the real database, never by app code
 * on a cold start (see `docs/cloudflare-deploy.md`).
 *
 * `AUTH_TENANT_ID` is a NEW requirement this path introduces — see that
 * file's "single-tenant auth" note for why `JwtAuthProvider` needs a fixed
 * tenant id at construction time and cannot be seeded around it here.
 */
async function buildD1BaseServices(): Promise<BaseServices> {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = await getCloudflareContext({ async: true });
  const binding = (env as Record<string, unknown>).DB as D1DatabaseBinding | undefined;
  if (!binding) {
    throw new Error(
      "Missing required D1 binding: DB. Add a [[d1_databases]] entry named \"DB\" to wrangler.toml " +
        "(see docs/cloudflare-deploy.md).",
    );
  }

  const database = new D1DatabaseProvider({ db: binding });
  const repositories = buildModuleRepositories(database);
  const credentialsRepository = new SqlCredentialsRepository(database);

  const tenantId = requireWorkersEnv(
    "AUTH_TENANT_ID",
    "This deployment cannot verify any session without knowing which tenant it serves — " +
      "set it to the account id already provisioned in this D1 database.",
  );

  const authProvider = new JwtAuthProvider(
    { secret: AUTH_SECRET, tenantId, issuer: AUTH_ISSUER, audience: AUTH_AUDIENCE },
    credentialsRepository,
    new PermissionService(),
  );

  return {
    repositories,
    credentialsRepository,
    authProvider,
    demoAccountId: null,
    demoOwnerUserId: null,
  };
}

/**
 * Dev/test path: sql.js, in-memory, freshly seeded every process start.
 * Unchanged from before this file grew a D1 branch — this is exactly what
 * ran here previously, just renamed so `build()` can dispatch to it.
 */
async function buildDevBaseServices(): Promise<BaseServices> {
  const accountId = randomUUID();
  const ownerId = randomUUID();
  const now = new Date().toISOString();

  const database = await SqlJsDatabaseProvider.create();
  runMigrations(database);

  await database.query(
    `insert into users (user_id, tenant_id, email, display_name, role, created_at, updated_at)
     values ($1, $2, $3, $4, 'owner', $5, $6)`,
    [ownerId, accountId, "owner@demo.test", "Demo Owner", now, now],
  );
  await database.query(
    `insert into accounts (id, name, owner_user_id, created_at, updated_at) values ($1, $2, $3, $4, $5)`,
    [accountId, "Demo Account", ownerId, now, now],
  );

  const repositories = buildModuleRepositories(database);
  const tenant: TenantContext = { tenantId: accountId as never };

  for (const seeder of SEEDERS) {
    await seeder({ repositories, tenant, ownerUserId: ownerId, now, database });
  }

  const credentialsRepository = new SqlCredentialsRepository(database);
  await seedUsers({ credentialsRepository, tenant, ownerUserId: ownerId, now });

  // Platform staff are seeded AFTER the tenant seeders, and separately from
  // them, because a platform principal is not a tenant member — it is an
  // orthogonal axis (SUPER_ADMIN_CONSOLE.md §2). Without this the console
  // is unreachable in dev: no user anywhere holds a platform-role grant, so
  // every platform route correctly refuses every caller and the screens can
  // never be exercised.
  const platformGrants = await seedPlatformRoleGrants({
    repositories,
    tenant,
    ownerUserId: ownerId,
    now,
    database,
  });
  await seedComplianceCaseDemo(
    { repositories, tenant, ownerUserId: ownerId, now, database },
    platformGrants,
  );
  await seedPlatformCredentials({ credentialsRepository, tenant, now, grants: platformGrants });

  const authProvider = new JwtAuthProvider(
    { secret: AUTH_SECRET, tenantId: accountId, issuer: AUTH_ISSUER, audience: AUTH_AUDIENCE },
    credentialsRepository,
    new PermissionService(),
  );

  return {
    repositories,
    credentialsRepository,
    authProvider,
    demoAccountId: accountId as TenantId,
    demoOwnerUserId: ownerId,
  };
}

/** Dispatches on the runtime, per `isWorkersRuntime`'s header. */
function build(): Promise<BaseServices> {
  return isWorkersRuntime() ? buildD1BaseServices() : buildDevBaseServices();
}

declare global {
  // eslint-disable-next-line no-var
  var __nexaraWebBase: Promise<BaseServices> | undefined;
}

/**
 * The single, process-wide base services (DB-backed repositories + auth
 * provider). Not tenant-scoped — used by `lib/session.ts` to verify a
 * session cookie, and by the `/api/auth/*` routes to log in/out.
 */
export function getBaseServices(): Promise<BaseServices> {
  globalThis.__nexaraWebBase ??= build();
  return globalThis.__nexaraWebBase;
}

/**
 * Every existing page/route's entry point — same shape as before this
 * task. The repositories are still the one process-wide singleton; the
 * TENANT now comes from the authenticated session (`lib/session.ts`'s
 * `getCurrentAuth()`), never a hardcoded constant. Throws
 * `AppError.unauthenticated` when there is no valid session — `proxy.ts`
 * is what stops an unauthenticated request from reaching a protected
 * page/route in the first place; this is the last-resort guard.
 */
export async function getContainer(): Promise<AppContainer> {
  const base = await getBaseServices();
  const auth = await getCurrentAuth();
  if (!auth) {
    throw AppError.unauthenticated("No active session");
  }
  return { repositories: base.repositories, tenant: auth.tenant, ownerUserId: auth.user.userId };
}
