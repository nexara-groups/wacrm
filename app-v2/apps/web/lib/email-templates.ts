/**
 * The two transactional message templates this slice needs. Plain functions
 * over an `EmailMessage` (`nexara/core/email`) — no vendor-specific shape
 * leaks in here, that translation happens inside each provider.
 */
import type { EmailMessage } from "@nexara/core/email";

/** `APP_BASE_URL` — where links in outbound email point. Falls back to the
 * local dev server so `next dev` produces a clickable link with zero setup. */
export function resolveAppBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = env.APP_BASE_URL?.trim();
  if (configured && configured.length > 0) return configured.replace(/\/+$/, "");
  return "http://localhost:3000";
}

export function buildInvitationAcceptUrl(token: string, env?: Record<string, string | undefined>): string {
  return `${resolveAppBaseUrl(env)}/accept-invite?token=${encodeURIComponent(token)}`;
}

export function buildVerifyEmailUrl(token: string, env?: Record<string, string | undefined>): string {
  return `${resolveAppBaseUrl(env)}/verify-email?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface InvitationEmailInput {
  readonly to: string;
  readonly role: string;
  readonly acceptUrl: string;
}

/** The invite email — carries the one-time accept link (raw token included
 * in `acceptUrl`, which the caller builds via `buildInvitationAcceptUrl`). */
export function buildInvitationEmail(input: InvitationEmailInput): EmailMessage {
  const subject = "You've been invited to join a WhatsApp CRM workspace";
  const text = [
    `You've been invited to join a team as ${input.role}.`,
    "",
    "Accept your invitation:",
    input.acceptUrl,
    "",
    "This link is single-use and expires in 7 days. If you weren't expecting this, you can ignore it.",
  ].join("\n");
  const html =
    `<p>You've been invited to join a team as <strong>${escapeHtml(input.role)}</strong>.</p>` +
    `<p><a href="${input.acceptUrl}">Accept your invitation</a></p>` +
    `<p>This link is single-use and expires in 7 days. If you weren't expecting this, you can ignore it.</p>`;
  return { to: input.to, subject, text, html };
}

export interface VerificationEmailInput {
  readonly to: string;
  readonly verifyUrl: string;
}

/** The email-verification email sent to a new owner when a real provider is
 * configured (see `app/api/auth/signup/route.ts`). */
export function buildVerificationEmail(input: VerificationEmailInput): EmailMessage {
  const subject = "Verify your email address";
  const text = [
    "Confirm your email to finish setting up your account:",
    input.verifyUrl,
    "",
    "This link expires in 24 hours.",
  ].join("\n");
  const html =
    "<p>Confirm your email to finish setting up your account.</p>" +
    `<p><a href="${input.verifyUrl}">Verify email</a></p>` +
    "<p>This link expires in 24 hours.</p>";
  return { to: input.to, subject, text, html };
}
