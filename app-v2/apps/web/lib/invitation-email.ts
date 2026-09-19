/**
 * Sends the invite email for a just-created invitation, and reports success
 * or failure WITHOUT throwing — a failed send must never fail the request
 * that created the invitation (see `app/api/invitations/route.ts`: the row
 * already exists and is recoverable; losing track of it would not be).
 *
 * -----------------------------------------------------------------------
 * WHY THE CATCH BLOCK NEVER TOUCHES `error.message`
 * -----------------------------------------------------------------------
 * `acceptUrl` carries the raw invitation token (see `email-templates.ts`).
 * A provider's thrown error is not something this file controls — a
 * different failure mode, a proxy, or a future provider could echo request
 * content back in its message. Rather than trust every current and future
 * `EmailProvider` implementation to never do that, this file simply never
 * reads `error.message` at all: neither the returned `emailError` (shown to
 * the API caller) nor what gets logged ever derives from the thrown value.
 * That is what makes "no raw token in any log or error path" true by
 * construction here, not by review.
 */
import type { EmailProvider } from "@nexara/core/email";
import { buildInvitationEmail } from "./email-templates";

export interface SendInvitationEmailParams {
  readonly emailProvider: EmailProvider;
  readonly to: string;
  readonly role: string;
  readonly acceptUrl: string;
}

export interface SendInvitationEmailResult {
  readonly emailSent: boolean;
  /** Present only when `emailSent` is false. A static, friendly message —
   * never anything derived from the provider's own error. */
  readonly emailError?: string;
}

function maskAddress(value: string): string {
  const [local, domain] = value.split("@");
  return local && domain ? `${local.slice(0, 1)}***@${domain}` : "[invalid-address]";
}

export async function sendInvitationEmail(params: SendInvitationEmailParams): Promise<SendInvitationEmailResult> {
  try {
    await params.emailProvider.send(
      buildInvitationEmail({ to: params.to, role: params.role, acceptUrl: params.acceptUrl }),
    );
    return { emailSent: true };
  } catch {
    console.error(
      `[invitations] failed to email invite to ${maskAddress(params.to)} via provider "${params.emailProvider.name}"`,
    );
    return {
      emailSent: false,
      emailError: "The invitation was created, but the email did not go out. Share the invite link with them directly.",
    };
  }
}
