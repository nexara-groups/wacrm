/**
 * Module composition root — the WACRM business modules, wired over the
 * framework container.
 *
 * DELIBERATELY SEPARATE from `nexara/core/container.ts`. That file is the
 * FRAMEWORK's composition root; it knows about providers, not products. If
 * `contacts` were added to its `Repositories` interface, the framework would
 * depend on a WACRM module and could no longer be reused by another Nexara
 * vertical without dragging this product's schema along. The dependency runs
 * one way only:
 *
 *     modules/container.ts  ->  nexara/core/container.ts     ✅
 *     nexara/core/container.ts  ->  modules/*                ❌
 *
 * Like the framework container, this is one of the few files allowed to name
 * concrete implementations. Everything downstream receives the interfaces.
 */
import type { DatabaseProvider } from "@nexara/core/database";
import type { Services } from "@nexara/core/container";
import { SqlContactRepository } from "./contacts/infrastructure/contact-repository";
import type { ContactRepository } from "./contacts/application/ports";

/**
 * Repositories owned by WACRM business modules, as interfaces.
 *
 * Modules land here as their persistence is implemented. Several currently
 * have domain and application layers but no repository yet (conversations,
 * broadcasts, whatsapp, meta-onboarding) — they are absent rather than
 * stubbed, so this type tells the truth about what can actually be wired.
 */
export interface ModuleRepositories {
  readonly contacts: ContactRepository;
}

export interface ModuleServices {
  readonly repositories: ModuleRepositories;
}

/**
 * Build the module layer over an already-built framework container.
 *
 * Takes `Services` rather than raw bindings so module wiring cannot bypass
 * the framework's provider selection — modules get the database the container
 * chose, never one they picked themselves. That is what keeps the DB decision
 * (still open, per DATABASE_DECISION.md) a single-place change.
 */
export function createModuleServices(services: Services): ModuleServices {
  return {
    repositories: buildModuleRepositories(services.database),
  };
}

/**
 * Exposed separately so a test or the dev harness can build the module layer
 * over a bare `DatabaseProvider` without standing up the whole framework
 * container (which needs Cloudflare bindings).
 */
export function buildModuleRepositories(database: DatabaseProvider): ModuleRepositories {
  return {
    contacts: new SqlContactRepository(database),
  };
}
