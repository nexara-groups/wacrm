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
import { fail, internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";

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

    // Switching to a DIFFERENT number is refused rather than half-done.
    // `upsert` is keyed on (account, phone_number_id), so a new id would
    // INSERT a second row while `listByAccount()[0]` — what every send route
    // reads — keeps returning the original. The operator would be told the
    // number was replaced while every message still went out on the old one.
    // Making this work needs a way to retire a config row, which the port
    // does not have; that is a port change, not something to improvise here.
    if (existing && existing.phoneNumberId !== input.phoneNumberId) {
      return fail(
        {
          code: "phone_number_change_unsupported",
          laymanMessage:
            `This account is connected to number ${existing.phoneNumberId}. ` +
            "Changing to a different number isn't supported yet — you can update the token for the current number.",
        },
        409,
      );
    }

    const { service } = await getWhatsAppContainer();
    const saved = await service.saveConfig({
      accountId,
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      // Meta owns these three; they arrive from a webhook or a later sync, and
      // inventing values here would be fabricating data the screen renders.
      displayName: existing?.displayName ?? null,
      qualityRating: existing?.qualityRating ?? null,
      verifiedName: existing?.verifiedName ?? null,
      // A newly entered number has not been registered by us. An existing
      // one keeps whatever state it had: re-entering a token does not undo a
      // completed registration.
      registrationState: existing?.registrationState ?? "pending",
      accessToken: input.accessToken,
    });

    return ok({ connection: toConnectionDTO(saved) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
