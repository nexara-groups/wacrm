/**
 * Server-side composition root for the web app.
 *
 * Builds the module repositories ONCE per process, backed by sql.js +
 * `runMigrations` — the same dev-harness wiring as `dev/server.ts`, reused
 * rather than reimplemented. The production datastore is still undecided
 * (see DATABASE_DECISION.md at the repo root); nothing here may be treated
 * as a production adapter.
 *
 * A demo account + a handful of contacts are seeded on first build so the
 * one screen this app ships has real data to show, read back through the
 * real `ContactRepository` — never a parallel copy of this data.
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
import type { PhoneNumber } from "@packages/domain";

export interface AppContainer {
  readonly repositories: ModuleRepositories;
  readonly tenant: TenantContext;
}

interface SeedRow {
  readonly name: string;
  readonly phone: string;
  readonly consent: "unknown" | "opted_in" | "opted_out" | "do_not_contact";
  readonly deliverability: "unknown" | "reachable" | "suppressed" | "manually_cleared";
  readonly reasonCode: string | null;
}

/**
 * Covers every consent x deliverability combination the contacts screen
 * needs to render, not just the happy path — those two axes are the whole
 * point of the row (see AGENTS build brief for this app).
 */
const SEED: readonly SeedRow[] = [
  { name: "Asha Reddy", phone: "+919876543210", consent: "opted_in", deliverability: "reachable", reasonCode: null },
  { name: "Vikram Nair", phone: "+919812345678", consent: "unknown", deliverability: "unknown", reasonCode: null },
  { name: "Priya Sharma", phone: "+919800000001", consent: "opted_in", deliverability: "suppressed", reasonCode: "131026" },
  { name: "Rahul Desai", phone: "+919800000002", consent: "opted_out", deliverability: "reachable", reasonCode: null },
  { name: "Meena Iyer", phone: "+919800000003", consent: "do_not_contact", deliverability: "reachable", reasonCode: null },
  { name: "Karthik Raman", phone: "+919800000004", consent: "opted_in", deliverability: "manually_cleared", reasonCode: null },
  { name: "Divya Menon", phone: "+919800000005", consent: "unknown", deliverability: "reachable", reasonCode: null },
];

async function seed(repositories: ModuleRepositories, tenant: TenantContext): Promise<void> {
  const now = new Date().toISOString();

  for (const row of SEED) {
    const created = await repositories.contacts.create(tenant, {
      phoneNumber: row.phone as unknown as PhoneNumber,
      displayName: row.name,
      email: null,
      company: null,
      consentState: row.consent,
      ...(row.consent === "opted_out" || row.consent === "do_not_contact"
        ? { optedOutAt: now, optOutSource: "operator", optOutEvidence: "seed data" }
        : {}),
    });
    if (row.deliverability !== "unknown") {
      await repositories.contacts.applyDeliverabilityPatch(tenant, created.id, {
        state: row.deliverability,
        suppressedAt: row.reasonCode === null ? null : now,
        suppressedReasonCode: row.reasonCode,
        suppressionStrikes: row.reasonCode === null ? 0 : 1,
      });
    }
  }
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

  await seed(repositories, tenant);

  return { repositories, tenant };
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
