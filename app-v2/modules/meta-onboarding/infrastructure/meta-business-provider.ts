/**
 * MetaGraphBusinessProvider — the Meta Graph API implementation of
 * `MetaBusinessProvider`. Vendor calls (fetch to graph.facebook.com) live
 * ONLY in this file within the module; `domain/` and `application/` never
 * import it directly, only its interface.
 *
 * Every failure is shaped into `MetaError` (`modules/messaging-errors`'s
 * envelope type) so `classify()` there can consume it — this file does NOT
 * classify errors itself or invent a second disposition/plain-English
 * table; that is `domain/onboarding-errors.ts`'s job, one layer up.
 *
 * SHAPES MARKED "ASSUMED" below have not been reconciled against Meta's
 * live Cloud API / Embedded Signup documentation for this build (no network
 * access during implementation) — verify each one before go-live, per
 * META_ERROR_TAXONOMY.md's own "Verify before implementing" note about the
 * adjacent error-code table. The Meta API version, base URL, register/
 * subscribe-app shapes and error envelope
 * (`{ error: { message, code, error_subcode, type } }`) are NOT assumptions
 * — they are read directly from `src/lib/whatsapp/meta-api.ts`, the
 * shipped reference implementation this module was told to read.
 */
import { err, ok, type Result } from "@shared/result";
import type { MetaError } from "@modules/messaging-errors/domain/meta-error-classifier";
import type {
  ExchangeCodeInput,
  ExchangedToken,
  MetaBusinessProvider,
  PhoneNumberDetails,
  RegisterPhoneNumberInput,
  RegisterPhoneNumberResult,
  SubscribeAppInput,
  VerificationStatus,
  WabaDetails,
} from "../domain/meta-business-provider.interface";

/** Matches `src/lib/whatsapp/meta-api.ts`'s `META_API_VERSION`/`META_API_BASE`. */
const DEFAULT_API_VERSION = "v21.0";
const DEFAULT_GRAPH_BASE = "https://graph.facebook.com";

export interface MetaGraphBusinessProviderConfig {
  /** Meta app id/secret — required for the OAuth code exchange (§ Embedded
   *  Signup prerequisites, META_ONBOARDING_FLOW.md). */
  readonly appId: string;
  readonly appSecret: string;
  readonly apiVersion?: string;
  readonly graphApiBase?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

interface MetaErrorEnvelope {
  readonly error?: {
    readonly message?: string;
    readonly code?: number;
    readonly error_subcode?: number;
    readonly type?: string;
    readonly error_data?: { readonly parameter?: string };
  };
}

interface RawCallResult {
  readonly status: number;
  readonly body: MetaErrorEnvelope & Record<string, unknown>;
}

export class MetaGraphBusinessProvider implements MetaBusinessProvider {
  readonly name = "meta-graph";
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: MetaGraphBusinessProviderConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
    this.base = `${config.graphApiBase ?? DEFAULT_GRAPH_BASE}/${config.apiVersion ?? DEFAULT_API_VERSION}`;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * Step 1 "Connect Meta". ASSUMED SHAPE: the standard Meta OAuth code
   * exchange — `GET /oauth/access_token?client_id=&client_secret=&redirect_uri=&code=`
   * — returning `{ access_token, token_type, expires_in? }`. Embedded
   * Signup for WhatsApp commonly returns a long-lived system-user token
   * here with no `expires_in`; both cases are handled
   * (`expiresInSeconds: null` when absent).
   */
  async exchangeCodeForToken(input: ExchangeCodeInput): Promise<Result<ExchangedToken, MetaError>> {
    const url = new URL(`${this.base}/oauth/access_token`);
    url.searchParams.set("client_id", this.appId);
    url.searchParams.set("client_secret", this.appSecret);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("code", input.code);

    const result = await this.call(url.toString(), { method: "GET" });
    if (!result.ok) return result;

    const body = result.value.body as { access_token?: string; token_type?: string; expires_in?: number };
    if (!body.access_token) {
      return err({ message: "Meta token exchange response was missing an access token", raw: body });
    }
    return ok({
      accessToken: body.access_token,
      tokenType: body.token_type ?? "bearer",
      expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : null,
    });
  }

  /** Step 2 "Store identifiers" (WABA half). */
  async getWabaDetails(wabaId: string, accessToken: string): Promise<Result<WabaDetails, MetaError>> {
    const url = `${this.base}/${encodeURIComponent(wabaId)}?fields=id,name,currency,timezone_id,owner_business_info`;
    const result = await this.call(url, { method: "GET" }, accessToken);
    if (!result.ok) return result;

    const body = result.value.body as {
      id?: string;
      name?: string;
      currency?: string;
      timezone_id?: string;
      owner_business_info?: { id?: string };
    };
    return ok({
      wabaId: body.id ?? wabaId,
      // ASSUMED SHAPE: `owner_business_info.id` as the owning Meta Business
      // id for a Tech-Provider-connected WABA. Falls back to the WABA id
      // itself when Meta's response doesn't carry it, so callers always get
      // a usable `businessId` rather than `undefined`.
      businessId: body.owner_business_info?.id ?? wabaId,
      name: body.name ?? null,
      currency: body.currency ?? null,
      timezoneId: body.timezone_id ?? null,
    });
  }

  /** Step 2 "Store identifiers" (phone half) — fields match
   *  `src/lib/whatsapp/meta-api.ts`'s `verifyPhoneNumber`, plus
   *  `code_verification_status` for the onboarding health check. */
  async getPhoneNumberDetails(phoneNumberId: string, accessToken: string): Promise<Result<PhoneNumberDetails, MetaError>> {
    const url = `${this.base}/${encodeURIComponent(phoneNumberId)}?fields=id,display_phone_number,verified_name,code_verification_status,quality_rating`;
    const result = await this.call(url, { method: "GET" }, accessToken);
    if (!result.ok) return result;

    const body = result.value.body as {
      id?: string;
      display_phone_number?: string;
      verified_name?: string;
      code_verification_status?: string;
      quality_rating?: string;
    };
    return ok({
      phoneNumberId: body.id ?? phoneNumberId,
      displayPhoneNumber: body.display_phone_number ?? "",
      verifiedName: body.verified_name ?? null,
      codeVerificationStatus: body.code_verification_status ?? null,
      qualityRating: body.quality_rating ?? null,
    });
  }

  /** Step 4 "Configure webhook" — matches `subscribeWabaToApp` in
   *  `src/lib/whatsapp/meta-api.ts` exactly (`POST /{wabaId}/subscribed_apps`,
   *  idempotent on Meta's side). */
  async subscribeAppToWaba(input: SubscribeAppInput): Promise<Result<void, MetaError>> {
    const url = `${this.base}/${encodeURIComponent(input.wabaId)}/subscribed_apps`;
    const result = await this.call(url, { method: "POST" }, input.accessToken);
    if (!result.ok) return result;
    return ok(undefined);
  }

  /** Step 3 "Register phone" — matches `registerPhoneNumber` in
   *  `src/lib/whatsapp/meta-api.ts`, including its "already registered"
   *  message-sniffing special case (Meta has no distinct error code for it
   *  in the reference implementation, only a message substring). */
  async registerPhoneNumber(input: RegisterPhoneNumberInput): Promise<Result<RegisterPhoneNumberResult, MetaError>> {
    const url = `${this.base}/${encodeURIComponent(input.phoneNumberId)}/register`;
    const result = await this.call(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", pin: input.pin }),
      },
      input.accessToken,
    );

    if (result.ok) return ok({ registered: true, alreadyRegistered: false });

    if (/already.*registered/i.test(result.error.message ?? "")) {
      return ok({ registered: true, alreadyRegistered: true });
    }
    return result;
  }

  /**
   * Step 6 "Health check". ASSUMED SHAPE: `name_status` alongside the
   * fields already used by `getPhoneNumberDetails` — Meta's phone-number
   * node reference documents display-name review status under this field
   * name; reconcile before go-live.
   */
  async getVerificationStatus(phoneNumberId: string, accessToken: string): Promise<Result<VerificationStatus, MetaError>> {
    const url = `${this.base}/${encodeURIComponent(phoneNumberId)}?fields=id,code_verification_status,quality_rating,name_status`;
    const result = await this.call(url, { method: "GET" }, accessToken);
    if (!result.ok) return result;

    const body = result.value.body as {
      id?: string;
      code_verification_status?: string;
      quality_rating?: string;
      name_status?: string;
    };
    return ok({
      phoneNumberId: body.id ?? phoneNumberId,
      codeVerificationStatus: body.code_verification_status ?? null,
      qualityRating: body.quality_rating ?? null,
      nameStatus: body.name_status ?? null,
    });
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  /**
   * One fetch, shaped into `Result<RawCallResult, MetaError>`. Never
   * throws: a network-level failure (timeout, DNS, connection reset) is
   * caught and shaped as `{ isNetworkError: true, ... }`, exactly the field
   * `modules/messaging-errors`'s `classify()` checks first.
   */
  private async call(url: string, init: RequestInit, accessToken?: string): Promise<Result<RawCallResult, MetaError>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
      });
    } catch (cause) {
      return err({
        isNetworkError: true,
        message: cause instanceof Error ? cause.message : "Network error calling Meta",
        raw: cause,
      });
    }

    let body: MetaErrorEnvelope & Record<string, unknown> = {};
    try {
      body = (await response.json()) as MetaErrorEnvelope & Record<string, unknown>;
    } catch {
      // No/invalid JSON body — `body` stays `{}`; the error branch below
      // falls back to the HTTP status for its message.
    }

    if (!response.ok) {
      return err({
        code: body.error?.code,
        subcode: body.error?.error_subcode,
        message: body.error?.message ?? `Meta API error: ${response.status}`,
        parameterName: body.error?.error_data?.parameter,
        httpStatus: response.status,
        raw: body,
      });
    }

    return ok({ status: response.status, body });
  }
}
