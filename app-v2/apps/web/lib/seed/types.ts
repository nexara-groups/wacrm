/**
 * The shape every seeder receives.
 *
 * Seeding is split one file per vertical slice (contacts, conversations,
 * broadcasts, team) rather than living in `lib/container.ts`, so the slices
 * can be built independently without editing a shared file — and so a slice
 * that has no demo data yet is an obviously-empty module rather than a gap
 * hidden inside a 200-line function.
 *
 * Every seeder writes through the REAL repositories. Nothing here may insert
 * a row the application layer could not have produced itself; a seed that
 * bypasses a repository would let a screen render data the real code path
 * can never make.
 */
import type { ModuleRepositories } from "@modules/container";
import type { TenantContext } from "@nexara/core/context";
import type { AtomicBatchDatabaseProvider } from "@nexara/core/database";

export interface SeedContext {
  readonly repositories: ModuleRepositories;
  readonly tenant: TenantContext;
  /** The seeded account's owner — use for `createdBy` / `invitedBy` fields. */
  readonly ownerUserId: string;
  /** One timestamp for the whole seed, so ordering is deterministic. */
  readonly now: string;
  /**
   * Escape hatch for rows no repository owns yet (e.g. a `users` row for a
   * second member). Prefer a repository; reach for this only when none
   * exists, and say why in a comment at the call site.
   */
  readonly database: AtomicBatchDatabaseProvider;
}

export type Seeder = (ctx: SeedContext) => Promise<void>;
