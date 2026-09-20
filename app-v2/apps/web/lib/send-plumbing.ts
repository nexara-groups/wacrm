/**
 * Plumbing shared by every WhatsApp send route (text, template, media,
 * interactive) under `app/api/conversations/[conversationId]/messages/*`.
 *
 * Extracted from the original text route so the consent/suppression
 * `SendFailure` -> HTTP mapping exists in exactly one place: four routes
 * hand-copying that switch is four chances for one of them to drop a case
 * (most dangerously `blocked`, which is the one guard that must never be
 * silently skipped — see `WhatsAppService.guardAndSend`).
 */
import { NextResponse } from "next/server";
import type { TenantContext } from "@nexara/core/context";
import { AccountId } from "@packages/domain/src/ids";
import type { ConversationId } from "@packages/domain/src/ids";
import type { ModuleRepositories } from "@modules/container";
import type { ConversationRecord } from "@modules/conversations/domain/conversation";
import type { ContactRecord } from "@modules/contacts/application/ports";
import type { WhatsAppConfigRecord } from "@modules/whatsapp/application/ports";
import type { SendFailure } from "@modules/whatsapp/application/whatsapp-service";
import { fail, notFoundError } from "./api-response";

/** The three things every send needs, resolved from the path's conversationId. */
export interface SendTarget {
  readonly conversation: ConversationRecord;
  readonly contact: ContactRecord;
  readonly config: WhatsAppConfigRecord;
}

export type SendTargetResult =
  | { readonly ok: true; readonly value: SendTarget }
  | { readonly ok: false; readonly response: NextResponse };

/**
 * Conversation -> contact -> WhatsApp config lookup, in that order, exactly
 * as the original text route performed it. A discriminated result rather
 * than a thrown response: throwing here would make every caller's single
 * try/catch responsible for telling a resolved-target 4xx apart from a real
 * unexpected error, which is exactly the ambiguity `parseOrThrow` avoids
 * for validation — this mirrors that choice.
 */
export async function resolveSendTarget(
  tenant: TenantContext,
  repositories: ModuleRepositories,
  conversationId: ConversationId,
): Promise<SendTargetResult> {
  const conversation = await repositories.conversations.findById(tenant, conversationId);
  if (!conversation) return { ok: false, response: notFoundError("conversation") };

  const contact = await repositories.contacts.findById(tenant, conversation.contactId);
  if (!contact) return { ok: false, response: notFoundError("contact") };

  const accountId = AccountId(tenant.tenantId);
  const configs = await repositories.whatsappConfig.listByAccount(accountId);
  const config = configs[0];
  if (!config) {
    return {
      ok: false,
      response: fail(
        {
          code: "whatsapp_not_configured",
          laymanMessage: "No WhatsApp number is set up for this account yet.",
        },
        409,
      ),
    };
  }

  return { ok: true, value: { conversation, contact, config } };
}

/**
 * Maps a `SendFailure` (WhatsAppService.guardAndSend's failure vocabulary)
 * onto the HTTP response every send route returns for it. MOVED verbatim
 * from the text route — same codes, same layman messages, same status
 * codes.
 *
 * Deliberately exhaustive with NO `default` case: `SendFailure["kind"]`
 * gaining a new member makes this a compile error (TS can no longer prove
 * every code path returns), not a silent fall-through to a 500 that hides a
 * failure kind nobody mapped yet.
 */
export function sendFailureResponse(failure: SendFailure): NextResponse {
  switch (failure.kind) {
    case "blocked": {
      const reason = failure.reason;
      const laymanMessage =
        reason.kind === "opted_out"
          ? "This person asked to stop receiving messages. You can't message them until they contact you again."
          : reason.kind === "do_not_contact"
            ? "This contact is marked do-not-contact and has been skipped."
            : "This number can't receive WhatsApp messages. We've stopped sending to it.";
      return fail({ code: `blocked_${reason.kind}`, laymanMessage }, 409);
    }
    case "config_not_found":
      return fail(
        { code: "whatsapp_not_configured", laymanMessage: "No WhatsApp number is set up for this account yet." },
        409,
      );
    case "provider_failure":
      return fail(
        {
          code: "provider_failure",
          laymanMessage: "WhatsApp couldn't deliver this message right now. Please try again.",
          operatorHint: failure.failure.metaError.message,
        },
        502,
      );
  }
}
