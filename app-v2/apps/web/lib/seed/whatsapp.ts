/**
 * Demo `whatsapp_configs` row.
 *
 * Without this, the demo account has no `phone_number_id` at all: every
 * send (`WhatsAppService.guardAndSend` -> `configs.findByPhoneNumberId`)
 * fails closed with `config_not_found`, and the inbound webhook receiver
 * (`app/api/webhooks/whatsapp/route.ts`) can never resolve a tenant for a
 * delivery, because there is no config row for it to match against
 * (`resolveTenantByPhoneNumberId` in `lib/whatsapp-container.ts`).
 *
 * `accessToken` is an obviously-fake placeholder, not a real Meta token —
 * this seeds the ROW, not a working credential; a real send in `next dev`
 * would still fail at Meta's end with this token, which is expected for a
 * demo harness with no real WABA behind it.
 */
import { AccountId } from "@packages/domain/src/ids";
import type { SeedContext } from "./types";

/** Exported so the webhook route's manual/dev testing and this seeder agree on one value. */
export const DEMO_PHONE_NUMBER_ID = "100000000000001";
export const DEMO_WABA_ID = "200000000000001";

export async function seedWhatsApp({ repositories, tenant }: SeedContext): Promise<void> {
  await repositories.whatsappConfig.upsert({
    accountId: AccountId(tenant.tenantId),
    phoneNumberId: DEMO_PHONE_NUMBER_ID,
    wabaId: DEMO_WABA_ID,
    displayName: "WACRM Demo",
    qualityRating: "GREEN",
    verifiedName: "WACRM Demo Business",
    registrationState: "registered",
    accessToken: "demo-not-a-real-meta-access-token",
  });
}
