/**
 * Decision logic for the WhatsApp connection settings screen
 * (`components/settings/whatsapp-connection-screen.tsx`), pulled out so it
 * has a plain `.ts` test next to it — same discipline as `template-status.ts`
 * (see `apps/web/AGENTS.md`'s testing note: vitest here has no React
 * harness, so anything with a decision in it lives outside the `.tsx`).
 */
import type { BadgeProps } from "@/components/ui/badge";
import type { WhatsappRegistrationState } from "@packages/contracts/src/onboarding";

// ---------------------------------------------------------------------------
// Registration state -> plain-language label/tone
//
// The enum is Meta/our-own plumbing vocabulary, not something an operator
// should have to decode. Only "registered" means the number can actually
// send — the other three are all "not sending yet", for different reasons,
// and get visibly different tone so a stuck registration doesn't read as
// healthy.
// ---------------------------------------------------------------------------

export const REGISTRATION_STATE_LABEL: Record<WhatsappRegistrationState, string> = {
  unregistered: "Not registered — can't send yet",
  pending: "Registration pending",
  registered: "Registered — sending",
  failed: "Registration failed",
};

export const REGISTRATION_STATE_VARIANT: Record<WhatsappRegistrationState, BadgeProps["variant"]> = {
  unregistered: "secondary",
  pending: "outline",
  registered: "success",
  failed: "destructive",
};

/** Whether this account can currently send WhatsApp messages. Only `registered` does. */
export function canSendMessages(state: WhatsappRegistrationState): boolean {
  return state === "registered";
}

// ---------------------------------------------------------------------------
// Form validity — all three fields are required by
// `saveWhatsappConnectionRequestSchema`; this mirrors that at the UI layer
// so the submit button disables before a round trip, not instead of one.
// ---------------------------------------------------------------------------

export interface WhatsappConnectionFormFields {
  readonly wabaId: string;
  readonly phoneNumberId: string;
  readonly accessToken: string;
}

export function isConnectionFormValid(fields: WhatsappConnectionFormFields): boolean {
  return (
    fields.wabaId.trim().length > 0 &&
    fields.phoneNumberId.trim().length > 0 &&
    fields.accessToken.trim().length > 0
  );
}

// ---------------------------------------------------------------------------
// Replacing a live credential is not cosmetic — saving when a connection
// already exists repoints every outbound message this account sends. This
// is deliberately a plain boolean gate (not copy baked into the component)
// so the "when do we warn" decision has its own test, independent of the
// exact wording rendered.
// ---------------------------------------------------------------------------

export const REPLACE_CONNECTION_WARNING =
  "Saving replaces the number this account currently sends WhatsApp messages from. This takes effect immediately.";

export function requiresReplaceConfirmation(hasExistingConnection: boolean): boolean {
  return hasExistingConnection;
}

// ---------------------------------------------------------------------------
// Save-error message selection.
//
// Every route under app/api (lib/api-response.ts) always answers with the
// shared envelope, success or failure, so the normal case is simply
// "render body.error.laymanMessage/operatorHint" — a 403 from the
// tenant:manage gate is exactly as ordinary as a 400 validation error here,
// not a special case. `body` is `null` only when the response could not be
// parsed as that envelope at all (a proxy/network failure, or a route that
// isn't wired up yet) — the one case with no server-authored message to
// show, where this falls back to a generic, honest one.
// ---------------------------------------------------------------------------

export interface SaveErrorEnvelope {
  readonly laymanMessage: string;
  readonly operatorHint?: string;
}

export interface SaveErrorDisplay {
  readonly message: string;
  readonly hint?: string;
}

const GENERIC_SAVE_ERROR = "Couldn't save the connection. Try again.";

export function selectSaveErrorMessage(
  status: number,
  body: { ok: false; error: SaveErrorEnvelope } | null,
): SaveErrorDisplay {
  if (body) {
    return { message: body.error.laymanMessage, hint: body.error.operatorHint };
  }
  // No parseable envelope — still say something true rather than nothing.
  if (status === 403) {
    return { message: "Only the account owner can change the WhatsApp number this account sends from." };
  }
  return { message: GENERIC_SAVE_ERROR };
}
