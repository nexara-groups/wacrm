/**
 * WhatsApp composition — builds the `WhatsAppService` (modules/whatsapp/
 * application/whatsapp-service.ts) over this app's process-wide
 * repositories, with the outbound Meta call injectable so tests never hit
 * the network.
 *
 * Deliberately separate from `getContainer()` in `lib/container.ts`:
 * `getContainer()` requires a session cookie (`getCurrentAuth()` throws
 * `AppError.unauthenticated` without one) and is unusable from the webhook
 * receiver, which by nature has no session — Meta calls it directly. This
 * module instead builds on `getBaseServices()`, the same process-wide,
 * NOT-tenant-scoped singleton `lib/session.ts` itself uses to verify a
 * cookie, so it carries no session dependency at all.
 *
 * `demoAccountId` — this app currently seeds exactly one account
 * (`lib/container.ts`'s `build()`), so it is also the one tenant a webhook
 * or a send-route call resolves to. `WhatsAppConfigRepositoryPort
 * .findByPhoneNumberId` still takes `(accountId, phoneNumberId)` — see this
 * module's `resolveTenantByPhoneNumberId` docstring for why that is a
 * genuine gap for a true multi-tenant deployment, worked around here only
 * because this app has a single tenant to try.
 */
import { MetaWhatsAppProvider } from "@modules/whatsapp/infrastructure/meta-whatsapp-provider";
import { WhatsAppService } from "@modules/whatsapp/application/whatsapp-service";
import type { WhatsAppProvider } from "@modules/whatsapp/domain/whatsapp-provider.interface";
import type { WhatsAppConfigRecord } from "@modules/whatsapp/application/ports";
import type { ModuleRepositories } from "@modules/container";
import type { TenantId } from "@shared/types";
import { getBaseServices } from "./container";

/** The real provider, built once per process — never constructed per-request. */
const defaultProvider: WhatsAppProvider = new MetaWhatsAppProvider();

export interface WhatsAppContainer {
  readonly repositories: ModuleRepositories;
  readonly service: WhatsAppService;
  /**
   * The one seeded demo account — see this file's header. `null` on a real
   * D1 deployment, where nothing is seeded (`lib/container.ts`'s
   * `buildD1BaseServices`); unused by both callers of this function today
   * (`resolveTenantByPhoneNumberId` derives the tenant from the stored
   * config row instead), so this being `null` in production breaks nothing.
   */
  readonly demoAccountId: TenantId | null;
}

/**
 * Builds the WhatsApp service over the app's real repositories.
 *
 * `providerOverride` is the injection point the task's SEND-path
 * requirement asks for ("the outbound Meta call must be injectable so
 * tests never hit the network"): a test passes a fake `WhatsAppProvider`
 * here; production and `next dev` never pass one and get the real
 * `MetaWhatsAppProvider`, which is the only place in this module that
 * calls `fetch` against Meta's Graph API.
 */
export async function getWhatsAppContainer(providerOverride?: WhatsAppProvider): Promise<WhatsAppContainer> {
  const base = await getBaseServices();
  const provider = providerOverride ?? defaultProvider;

  const service = new WhatsAppService({
    provider,
    configs: base.repositories.whatsappConfig,
    templates: base.repositories.messageTemplates,
    webhookEvents: base.repositories.webhookEvents,
    contactState: base.repositories.contactState,
  });

  return { repositories: base.repositories, service, demoAccountId: base.demoAccountId };
}

/**
 * Resolves the tenant that owns `phoneNumberId`, for the UNAUTHENTICATED
 * webhook receiver — never `getContainer()`, which needs a session this
 * request does not carry.
 *
 * KNOWN GAP, reported rather than worked around with SQL or a new port
 * method (per this task's hard rules): `WhatsAppConfigRepositoryPort` (see
 * `modules/whatsapp/application/ports.ts`) exposes only
 * `findByPhoneNumberId(accountId, phoneNumberId)` — it requires the tenant
 * to already be known, which is exactly what a real multi-tenant deploy
 * does NOT have at this point in the webhook request. The `whatsapp_configs`
 * table does carry a UNIQUE index on `phone_number_id` alone
 * (`db/migrations/d1/0006_whatsapp.sql`), so a cross-tenant lookup keyed on
 * phone_number_id alone is possible at the schema level — there is simply
 * no port method that exposes it. This app seeds exactly one account
 * (`lib/container.ts`), so trying that one account's id is correct here and
 * will keep working right up until a second account's config is seeded;
 * it is not a fix for the missing port method, and does not become one by
 * working in this single-tenant demo. A real fix needs
 * `WhatsAppConfigRepositoryPort` to gain a `findByPhoneNumberId(phoneNumberId)`
 * (no accountId) overload backed by that unique index — outside this
 * task's allowed surface (`modules/whatsapp/**` is read-only per the task
 * brief's file list).
 */
/**
 * Resolve which tenant an inbound Meta delivery belongs to.
 *
 * Meta identifies the destination by `phone_number_id` and nothing else — it
 * has no notion of our accounts — so this is the webhook's first question,
 * before any tenant-scoped work can happen.
 *
 * `findByPhoneNumberIdGlobal` answers it from the UNIQUE index on
 * `phone_number_id`, so at most one row can come back. Everything after this
 * point scopes by the `accountId` ON THAT ROW, never one the caller supplied:
 * the tenant is derived from trusted stored data, not asserted by the
 * request.
 *
 * This replaced a version that guessed the single seeded demo account, which
 * worked only while exactly one tenant existed and would have silently
 * dropped every message for tenant number two.
 */
export async function resolveTenantByPhoneNumberId(
  repositories: ModuleRepositories,
  phoneNumberId: string,
): Promise<WhatsAppConfigRecord | null> {
  return repositories.whatsappConfig.findByPhoneNumberIdGlobal(phoneNumberId);
}
