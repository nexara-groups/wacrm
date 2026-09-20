/**
 * `GET/PUT /api/whatsapp/connection` — read, and set, the number this tenant
 * sends from. Until now the only way a `whatsapp_configs` row existed was a
 * hand-written seed, so no real tenant could connect its own number.
 *
 * Three properties this route exists to hold, none of them cosmetic:
 *
 * 1. THE TOKEN IS WRITE-ONLY. `whatsappConnectionSchema` carries
 *    `hasAccessToken`, never the token or any part of it. A masked echo would
 *    still put a tenant's Meta credential into a browser cache, a proxy log
 *    and every screenshot of this screen, and buys the operator nothing they
 *    cannot get from Meta's own console. Nothing here logs the body either.
 *
 * 2. THE TENANT COMES FROM THE SESSION. `saveWhatsappConnectionRequestSchema`
 *    deliberately has no `accountId` (unlike the older
 *    `connectMetaManuallyRequestSchema` beside it in the contract), because a
 *    body-supplied account id on this endpoint is a write-someone-else's-
 *    credentials bug waiting to be written.
 *
 * 3. WRITING IS OWNER-ONLY. Replacing the token repoints every outbound
 *    message this account sends, so it sits behind `authorizeAction
 *    ("whatsapp:connect")` (`@/lib/authorize-route`), which
 *    `ACTION_MINIMUM_ROLE` (`@/lib/route-authorization`) maps to `owner`
 *    alone. Reading is open to any member of the tenant: it discloses no
 *    secret and an agent needs to see whether the account is connected at
 *    all. This was the one write route gated before that table existed; it
 *    now uses the same mechanism as every other one.
 *
 * Storage-side encryption is not this route's business: the repository seals
 * the token on write and opens it on read (see `WhatsAppConfigRepository`).
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  saveWhatsappConnectionRequestSchema,
  type WhatsappConnection,
} from "@packages/contracts/src/onboarding";
import { AccountId } from "@packages/domain/src/ids";
import type { WhatsAppConfigRecord } from "@modules/whatsapp/application/ports";
import { getContainer } from "@/lib/container";
import { getWhatsAppContainer } from "@/lib/whatsapp-container";
import { authorizeAction } from "@/lib/authorize-route";
import { internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";

function toConnectionDTO(config: WhatsAppConfigRecord): WhatsappConnection {
  return {
    phoneNumberId: config.phoneNumberId,
    wabaId: config.wabaId,
    displayName: config.displayName,
    verifiedName: config.verifiedName,
    qualityRating: config.qualityRating,
    registrationState: config.registrationState,
    // The one thing said about the token, ever.
    hasAccessToken: config.accessToken.length > 0,
    updatedAt: config.updatedAt,
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const { repositories, tenant } = await getContainer();
    const configs = await repositories.whatsappConfig.listByAccount(AccountId(tenant.tenantId));
    const config = configs[0];
    return ok({ connection: config ? toConnectionDTO(config) : null });
  } catch (error) {
    return internalError(error);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    // Same mechanism as every other gated write now — see
    // lib/route-authorization.ts for why `whatsapp:connect` is owner-only.
    const authorized = await authorizeAction("whatsapp:connect");
    if (!authorized.ok) return authorized.response;

    const { repositories, tenant } = await getContainer();

    const json: unknown = await request.json().catch(() => ({}));
    const body = (json ?? {}) as Record<string, unknown>;
    const input = parseOrThrow(saveWhatsappConnectionRequestSchema, {
      wabaId: body.wabaId,
      phoneNumberId: body.phoneNumberId,
      accessToken: body.accessToken,
    });

    const accountId = AccountId(tenant.tenantId);
    const existing = (await repositories.whatsappConfig.listByAccount(accountId))[0];

    // Changing to a DIFFERENT number is a replacement, not an addition, and
    // goes through `replaceConfig` — `saveConfig`/`upsert` is keyed on the
    // phone number, so it would leave the old row in place and every send
    // route (all of which read the account's first config) would keep using
    // it while the operator was told the number had changed.
    const isNewNumber = existing !== undefined && existing.phoneNumberId !== input.phoneNumberId;

    const { service } = await getWhatsAppContainer();
    const save = isNewNumber ? service.replaceConfig.bind(service) : service.saveConfig.bind(service);
    const saved = await save({
      accountId,
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      // Meta owns these three. They are carried over only when the number is
      // unchanged; on a new number they describe the OLD one, and copying
      // them across would label the new number with the previous number's
      // verified name and quality rating.
      displayName: isNewNumber ? null : (existing?.displayName ?? null),
      qualityRating: isNewNumber ? null : (existing?.qualityRating ?? null),
      verifiedName: isNewNumber ? null : (existing?.verifiedName ?? null),
      // A number we have not registered is pending. Re-entering a token for
      // the SAME number does not undo a completed registration; switching to
      // a new one starts over, because nothing has registered it yet.
      registrationState: isNewNumber ? "pending" : (existing?.registrationState ?? "pending"),
      accessToken: input.accessToken,
    });

    return ok({ connection: toConnectionDTO(saved) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
