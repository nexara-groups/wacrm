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
 */
import { randomUUID } from "node:crypto";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
// The real migration runner, not a copy: db/sqlite/run-migrations.ts no
// longer uses the `new URL(..., import.meta.url)` form that Turbopack
// special-cases, so it bundles cleanly now.
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { buildModuleRepositories, type ModuleRepositories } from "@modules/container";
import type { TenantContext } from "@nexara/core/context";
import { seedContacts } from "./seed/contacts";
import { seedConversations } from "./seed/conversations";
import { seedBroadcasts } from "./seed/broadcasts";
import { seedTeam } from "./seed/team";
import type { Seeder } from "./seed/types";

/** Order matters: later seeders may reference rows earlier ones created. */
const SEEDERS: readonly Seeder[] = [seedContacts, seedTeam, seedConversations, seedBroadcasts];

export interface AppContainer {
  readonly repositories: ModuleRepositories;
  readonly tenant: TenantContext;
  readonly ownerUserId: string;
}

async function build(): Promise<AppContainer> {
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

  return { repositories, tenant, ownerUserId: ownerId };
}

declare global {
  // eslint-disable-next-line no-var
  var __nexaraWebContainer: Promise<AppContainer> | undefined;
}

/** The single, process-wide container. Every route/page calls this. */
export function getContainer(): Promise<AppContainer> {
  globalThis.__nexaraWebContainer ??= build();
  return globalThis.__nexaraWebContainer;
}
