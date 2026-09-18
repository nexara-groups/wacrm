/**
 * Module composition root — the WACRM business modules, wired over the
 * framework container.
 *
 * DELIBERATELY SEPARATE from `nexara/core/container.ts`. That file is the
 * FRAMEWORK's composition root; it knows about providers, not products. If
 * these repositories were added to its `Repositories` interface, the
 * framework would depend on WACRM modules and could no longer be reused by
 * another Nexara vertical without dragging this product's schema along. The
 * dependency runs one way only, and a test enforces it:
 *
 *     modules/container.ts  ->  nexara/core/container.ts     ✅
 *     nexara/core/container.ts  ->  modules/*                ❌
 *
 * Like the framework container, this is one of the few files allowed to name
 * concrete implementations. Everything downstream receives the interfaces.
 */
import type { AtomicBatchDatabaseProvider } from "@nexara/core/database";
import type { Services } from "@nexara/core/container";

import { SqlContactRepository } from "./contacts/infrastructure/contact-repository";
import type { ContactRepository } from "./contacts/application/ports";

import { SqlConversationRepository } from "./conversations/infrastructure/conversation-repository";
import { SqlMessageRepository } from "./conversations/infrastructure/message-repository";
import type { ConversationRepository, MessageRepository } from "./conversations/application/ports";

import {
  SqlBroadcastRecipientRepository,
  SqlBroadcastRepository,
} from "./broadcasts/infrastructure/broadcast-repository";
import type {
  BroadcastRecipientRepositoryPort,
  BroadcastRepositoryPort,
} from "./broadcasts/application/ports";

import {
  ContactStateRepository,
  MessageTemplateRepository,
  WebhookEventRepository,
  WhatsAppConfigRepository,
} from "./whatsapp/infrastructure/whatsapp-repository";
import type {
  ContactStateRepositoryPort,
  MessageTemplateRepositoryPort,
  WebhookEventRepositoryPort,
  WhatsAppConfigRepositoryPort,
} from "./whatsapp/application/ports";

import { OnboardingSqlRepository } from "./meta-onboarding/infrastructure/onboarding-repository";

import { SqlSeatRepository } from "./organizations/infrastructure/seat-repository";
import type { SeatRepository } from "./organizations/application/ports";

import { SqlUserRepository } from "./identity/infrastructure/user-repository";
import { SqlSessionRepository } from "./identity/infrastructure/session-repository";
import { SqlRefreshTokenRepository } from "./identity/infrastructure/refresh-token-repository";
import { SqlEmailTokenRepository } from "./identity/infrastructure/email-token-repository";
import { SqlDeviceInstallationRepository } from "./identity/infrastructure/device-installation-repository";
import type {
  DeviceInstallationRepositoryPort,
  SessionRepositoryPort,
  UserRepositoryPort,
} from "./identity/application/ports";
// These two ports are declared in domain/ rather than application/ports.ts:
// rotation and single-use token consumption are pure domain rules, and the
// port travels with the rule that defines it.
import type { RefreshTokenPort } from "./identity/domain/refresh-token-rotation";
import type { EmailTokenPort } from "./identity/domain/email-tokens";

/**
 * Repositories owned by WACRM business modules, as interfaces.
 *
 * Every module's persistence now exists and is exercised against the real
 * migrated schema, so this type lists all of them. When it listed only
 * `contacts`, that was not an oversight — the others genuinely had no
 * implementation, and the type said so rather than stubbing them.
 */
export interface ModuleRepositories {
  readonly contacts: ContactRepository;

  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;

  readonly broadcasts: BroadcastRepositoryPort;
  readonly broadcastRecipients: BroadcastRecipientRepositoryPort;

  readonly whatsappConfig: WhatsAppConfigRepositoryPort;
  readonly messageTemplates: MessageTemplateRepositoryPort;
  readonly webhookEvents: WebhookEventRepositoryPort;
  /** Deliverability/consent writes issued by the messaging path. */
  readonly contactState: ContactStateRepositoryPort;

  readonly onboarding: OnboardingSqlRepository;

  readonly seats: SeatRepository;

  readonly users: UserRepositoryPort;
  readonly sessions: SessionRepositoryPort;
  readonly refreshTokens: RefreshTokenPort;
  readonly emailTokens: EmailTokenPort;
  readonly deviceInstallations: DeviceInstallationRepositoryPort;
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
  if (!("batch" in services.database) || typeof services.database.batch !== "function") {
    throw new Error(
      "module repositories require a database provider with atomic batch support " +
        `(got "${services.database.name}")`,
    );
  }
  return {
    repositories: buildModuleRepositories(services.database as AtomicBatchDatabaseProvider),
  };
}

/**
 * Exposed separately so a test or the dev harness can build the module layer
 * over a bare provider without standing up the whole framework container
 * (which needs Cloudflare bindings).
 *
 * Requires `AtomicBatchDatabaseProvider`, not plain `DatabaseProvider`:
 * repositories perform multi-statement writes atomically via `batch()`, which
 * is the only atomic primitive BOTH candidate stores support. D1 has no
 * interactive transactions at all.
 */
export function buildModuleRepositories(
  database: AtomicBatchDatabaseProvider,
): ModuleRepositories {
  return {
    contacts: new SqlContactRepository(database),

    conversations: new SqlConversationRepository(database),
    messages: new SqlMessageRepository(database),

    broadcasts: new SqlBroadcastRepository(database),
    broadcastRecipients: new SqlBroadcastRecipientRepository(database),

    whatsappConfig: new WhatsAppConfigRepository(database),
    messageTemplates: new MessageTemplateRepository(database),
    webhookEvents: new WebhookEventRepository(database),
    contactState: new ContactStateRepository(database),

    onboarding: new OnboardingSqlRepository(database),

    seats: new SqlSeatRepository(database),

    users: new SqlUserRepository(database),
    sessions: new SqlSessionRepository(database),
    refreshTokens: new SqlRefreshTokenRepository(database),
    emailTokens: new SqlEmailTokenRepository(database),
    deviceInstallations: new SqlDeviceInstallationRepository(database),
  };
}
