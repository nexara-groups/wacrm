/**
 * MetaBusinessProvider — the onboarding/provisioning port.
 *
 * Deliberately SEPARATE from `WhatsAppProvider` (ongoing messaging: send,
 * receive, templates). Per META_ONBOARDING_FLOW.md:
 *
 *   MetaBusinessProvider   -> onboarding/provisioning (Embedded Signup,
 *                              token exchange, phone register, webhook
 *                              subscribe, WABA/phone status)
 *   MetaOnboardingService  -> orchestrates the state machine
 *   WhatsAppProvider       -> ongoing messaging — separate concern, separate
 *                              Meta API surface, NOT this file
 *
 * "Do not mix onboarding responsibilities into messaging logic" is an
 * explicit architecture decision, not an accident of file layout: a
 * onboarding bug must never be able to touch the send path, and vice versa.
 *
 * Interface only — no `fetch`, no Meta Graph API shape leaks past this file.
 * The real implementation lives in `infrastructure/meta-business-provider.ts`,
 * the one place in this module allowed to speak HTTP to Meta.
 *
 * Every method returns `Result<T, MetaError>` rather than throwing.
 * `MetaError` is imported from `modules/messaging-errors` — NOT redefined
 * here — so that every failure this port can produce is guaranteed
 * classifiable by that module's `classify()` (see
 * `infrastructure/meta-business-provider.ts` and `domain/onboarding-errors.ts`,
 * which both depend on that guarantee).
 */
import type { Result } from "@shared/result";
import type { MetaError } from "@modules/messaging-errors/domain/meta-error-classifier";

// ---------------------------------------------------------------------------
// 1. Exchange the Embedded Signup code for a token
// ---------------------------------------------------------------------------

export interface ExchangeCodeInput {
  /** The `code` Facebook Login for Business hands back to the Embedded
   *  Signup callback. Single-use, short-lived. */
  readonly code: string;
  readonly redirectUri: string;
}

export interface ExchangedToken {
  /**
   * The raw bearer token. NEVER persist this value directly — see
   * `application/ports.ts`'s `SecretStorePort` and
   * `db/migrations/*/0010_meta_onboarding.sql`'s `access_token_ref` column
   * comment. This type exists only to move the value from this port to the
   * secret store in the same request; nothing downstream of that call
   * should still be holding it.
   */
  readonly accessToken: string;
  readonly tokenType: string;
  /** `null` when Meta's response omitted an expiry (long-lived/system-user
   *  tokens commonly do). */
  readonly expiresInSeconds: number | null;
}

// ---------------------------------------------------------------------------
// 2. WABA + phone-number details
// ---------------------------------------------------------------------------

export interface WabaDetails {
  readonly wabaId: string;
  readonly businessId: string;
  readonly name: string | null;
  readonly currency: string | null;
  readonly timezoneId: string | null;
}

export interface PhoneNumberDetails {
  readonly phoneNumberId: string;
  readonly displayPhoneNumber: string;
  readonly verifiedName: string | null;
  readonly codeVerificationStatus: string | null;
  readonly qualityRating: string | null;
}

// ---------------------------------------------------------------------------
// 3. Subscribe the app to the WABA (webhook configuration, step 4)
// ---------------------------------------------------------------------------

export interface SubscribeAppInput {
  readonly wabaId: string;
  readonly accessToken: string;
}

// ---------------------------------------------------------------------------
// 4. Register the phone number (2-step-verification PIN, step 3)
// ---------------------------------------------------------------------------

export interface RegisterPhoneNumberInput {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  /** 6-digit PIN set in Meta WhatsApp Manager -> Two-step verification. */
  readonly pin: string;
}

export interface RegisterPhoneNumberResult {
  readonly registered: boolean;
  /** True when Meta reported the number as already registered to this app —
   *  same outcome as a fresh registration, surfaced separately for the audit
   *  trail (mirrors `src/lib/whatsapp/meta-api.ts`'s `alreadyRegistered`). */
  readonly alreadyRegistered: boolean;
}

// ---------------------------------------------------------------------------
// 5. Verification + quality status (health check, step 6)
// ---------------------------------------------------------------------------

export interface VerificationStatus {
  readonly phoneNumberId: string;
  readonly codeVerificationStatus: string | null;
  readonly qualityRating: string | null;
  readonly nameStatus: string | null;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface MetaBusinessProvider {
  /** Provider identifier, e.g. "meta-graph". */
  readonly name: string;

  /** Step 1 "Connect Meta" — exchange the Embedded Signup `code` for a token. */
  exchangeCodeForToken(input: ExchangeCodeInput): Promise<Result<ExchangedToken, MetaError>>;

  /** Step 2 "Store identifiers" — read WABA metadata to persist alongside the connection. */
  getWabaDetails(wabaId: string, accessToken: string): Promise<Result<WabaDetails, MetaError>>;

  /** Step 2 "Store identifiers" — read phone-number metadata to persist alongside the connection. */
  getPhoneNumberDetails(phoneNumberId: string, accessToken: string): Promise<Result<PhoneNumberDetails, MetaError>>;

  /** Step 4 "Configure webhook" — subscribe this app to the WABA's events. Idempotent on Meta's side. */
  subscribeAppToWaba(input: SubscribeAppInput): Promise<Result<void, MetaError>>;

  /** Step 3 "Register phone" — set the 2-step-verification PIN via `/register`. */
  registerPhoneNumber(input: RegisterPhoneNumberInput): Promise<Result<RegisterPhoneNumberResult, MetaError>>;

  /** Step 6 "Health check" — verify token validity + phone/quality status. */
  getVerificationStatus(phoneNumberId: string, accessToken: string): Promise<Result<VerificationStatus, MetaError>>;
}
