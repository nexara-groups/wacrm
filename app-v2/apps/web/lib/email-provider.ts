/**
 * Selects the `EmailProvider` (`nexara/core/email`) for the current
 * deployment. This is the ONLY place a vendor is chosen — every adapter
 * (`ConsoleEmailProvider`, `ResendEmailProvider`, `SesEmailProvider`,
 * `BrevoEmailProvider`, `UnavailableEmailProvider`,
 * `RecipientAllowlistEmailProvider`) already exists under
 * `nexara/core/email/providers/*`; nothing here writes a new one.
 *
 * Selection is driven entirely by `EMAIL_PROVIDER` (+ each vendor's own
 * credential vars), read here and nowhere else — no vendor name is ever
 * hardcoded, matching `lib/container.ts`'s database selection (sql.js vs
 * D1, switched structurally by `isWorkersRuntime()`, never by a flag that
 * can be forgotten).
 *
 * -----------------------------------------------------------------------
 * SAFE BY DEFAULT — the actual point of this file
 * -----------------------------------------------------------------------
 * `EMAIL_PROVIDER` unset means "nothing configured", and what that resolves
 * to depends on the runtime, never on a guess:
 *   - `runtime === "dev"` (local `next dev`, `vitest run`) -> `ConsoleEmailProvider`.
 *     Logs instead of sending; safe because nothing here is a real deploy.
 *   - `runtime === "workers"` (a real Cloudflare deployment) -> `UnavailableEmailProvider`.
 *     Every `send()` throws. A production deployment that forgot to
 *     configure a vendor must fail LOUDLY the first time something tries to
 *     send mail — never silently succeed while reaching no inbox. That
 *     failure is also what `isRealEmailProviderConfigured` below turns into
 *     "verification is not required" for signup, so the two halves of this
 *     file agree with each other by construction: if sending would throw,
 *     nothing downstream requires a send to have gone out first.
 * Setting `EMAIL_PROVIDER=console` explicitly forces the console adapter
 * even on Workers (e.g. a staging Worker that must never send real mail).
 *
 * `EMAIL_RECIPIENT_ALLOWLIST` (comma-separated addresses), if set, wraps
 * whatever was selected in `RecipientAllowlistEmailProvider` — useful for a
 * staging deployment that runs a REAL vendor but must never reach a real
 * inbox outside the team.
 */
import type { EmailProvider } from "@nexara/core/email";
import { ConsoleEmailProvider } from "@nexara/core/email/providers/console-email-provider";
import { UnavailableEmailProvider } from "@nexara/core/email/providers/unavailable-email-provider";
import { ResendEmailProvider } from "@nexara/core/email/providers/resend-email-provider";
import { SesEmailProvider } from "@nexara/core/email/providers/ses-email-provider";
import { BrevoEmailProvider } from "@nexara/core/email/providers/brevo-email-provider";
import {
  RecipientAllowlistEmailProvider,
  parseRecipientAllowlist,
} from "@nexara/core/email/providers/recipient-allowlist-email-provider";

export type EmailRuntime = "workers" | "dev";
export type EnvLike = Record<string, string | undefined>;

/** Vendors that actually reach a real inbox — everything else (`console`,
 * `unavailable`) is a stand-in, never a delivery capability. */
const REAL_PROVIDERS = new Set(["resend", "ses", "brevo"]);

function requestedProvider(env: EnvLike): string | undefined {
  const raw = env.EMAIL_PROVIDER?.trim().toLowerCase();
  return raw && raw.length > 0 ? raw : undefined;
}

function requireEnv(env: EnvLike, name: string, why: string): string {
  const value = env[name];
  if (value !== undefined && value.length > 0) return value;
  throw new Error(`${name} is not set. ${why}`);
}

/**
 * The capability check the whole email-verification-required rule keys
 * off (see `apps/web/app/api/auth/signup/route.ts`): true only when a
 * vendor that can actually deliver mail is configured. `console` and
 * `unavailable` are deliberately NOT "real" — requiring verification while
 * nothing can ever send it would lock every new owner out forever.
 */
export function isRealEmailProviderConfigured(env: EnvLike = process.env): boolean {
  const requested = requestedProvider(env);
  return requested !== undefined && REAL_PROVIDERS.has(requested);
}

/** Builds the `EmailProvider` for one process. Pure function of `env` +
 * `runtime` so it can be unit-tested without touching `process.env`. */
export function selectEmailProvider(
  env: EnvLike = process.env,
  runtime: EmailRuntime = "dev",
): EmailProvider {
  const requested = requestedProvider(env);
  let base: EmailProvider;

  if (requested === undefined) {
    base = runtime === "workers" ? new UnavailableEmailProvider() : new ConsoleEmailProvider();
  } else if (requested === "console") {
    base = new ConsoleEmailProvider();
  } else if (requested === "unavailable") {
    base = new UnavailableEmailProvider();
  } else if (requested === "resend") {
    base = new ResendEmailProvider({
      apiKey: requireEnv(env, "RESEND_API_KEY", "Set it to your Resend API key, or unset EMAIL_PROVIDER."),
      from: requireEnv(env, "EMAIL_FROM", "Set the address transactional email is sent from."),
    });
  } else if (requested === "ses") {
    base = new SesEmailProvider({
      region: requireEnv(env, "SES_REGION", "Set the AWS region SES is configured in."),
      accessKeyId: requireEnv(env, "SES_ACCESS_KEY_ID", "Set an IAM access key with ses:SendEmail."),
      secretAccessKey: requireEnv(env, "SES_SECRET_ACCESS_KEY", "Set the matching IAM secret key."),
      from: requireEnv(env, "EMAIL_FROM", "Set the address transactional email is sent from."),
    });
  } else if (requested === "brevo") {
    base = new BrevoEmailProvider({
      apiKey: requireEnv(env, "BREVO_API_KEY", "Set it to your Brevo API key."),
      fromEmail: requireEnv(env, "EMAIL_FROM", "Set the address transactional email is sent from."),
      fromName: env.EMAIL_FROM_NAME?.trim() || "WhatsApp CRM",
    });
  } else {
    throw new Error(
      `Unknown EMAIL_PROVIDER "${requested}". Expected one of: console, resend, ses, brevo, unavailable.`,
    );
  }

  const allowlist = env.EMAIL_RECIPIENT_ALLOWLIST;
  if (allowlist !== undefined && allowlist.length > 0) {
    base = new RecipientAllowlistEmailProvider(base, parseRecipientAllowlist(allowlist));
  }
  return base;
}
