/**
 * Onboarding — the Embedded Signup wizard steps, current state, and resume.
 *
 * META_ONBOARDING_FLOW.md's state machine, verbatim:
 *   created -> meta_connected -> phone_registered -> webhook_verified ->
 *   template_ready -> complete
 * "Failure/retry states required — a failed provider call must NOT
 * permanently lock the account in an intermediate state (retryable +
 * resumable)" — modelled here as a per-step status (not a per-account one),
 * so a failure on step 3 does not erase that steps 1-2 already succeeded.
 */
import { z } from "zod";
import { accountIdSchema, isoDateTimeSchema } from "./common/ids";
import { errorEnvelopeSchema } from "./common/error-envelope";
import { apiResult } from "./common/response";

export const onboardingStepSchema = z.enum([
  "created",
  "meta_connected",
  "phone_registered",
  "webhook_verified",
  "template_ready",
  "complete",
]);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

/** META_ONBOARDING_FLOW.md's ordering — index into this array is used to render wizard progress. */
export const ONBOARDING_STEP_ORDER = [
  "created",
  "meta_connected",
  "phone_registered",
  "webhook_verified",
  "template_ready",
  "complete",
] as const satisfies readonly OnboardingStep[];

export const onboardingStepStatusSchema = z.enum(["pending", "in_progress", "complete", "failed"]);
export type OnboardingStepStatus = z.infer<typeof onboardingStepStatusSchema>;

export const onboardingStepStateSchema = z.object({
  step: onboardingStepSchema,
  status: onboardingStepStatusSchema,
  /** Set only when `status === "failed"` — reuses the shared error envelope so a failed onboarding step surfaces exactly like any other failure (META_ERROR_TAXONOMY.md §4b). Retryable: a failed step does not lock the wizard. */
  error: errorEnvelopeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
});
export type OnboardingStepState = z.infer<typeof onboardingStepStateSchema>;

export const onboardingStateSchema = z.object({
  accountId: accountIdSchema,
  currentStep: onboardingStepSchema,
  steps: z.array(onboardingStepStateSchema),
  /** Set once "Connect Meta" succeeds — null before then. Never the access token itself (§2 "token server-side only, never client-visible"). */
  wabaId: z.string().min(1).nullable(),
  phoneNumberId: z.string().min(1).nullable(),
  isComplete: z.boolean(),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

// ---------------------------------------------------------------------------
// Get current state / resume — same response shape: "resume" is simply
// "fetch current state and render the wizard at `currentStep`", which is
// exactly what makes the flow resumable per the spec's retry requirement.
// ---------------------------------------------------------------------------

export const getOnboardingStateRequestSchema = z.object({ accountId: accountIdSchema });
export type GetOnboardingStateRequest = z.infer<typeof getOnboardingStateRequestSchema>;

export const getOnboardingStateResponseSchema = apiResult({ state: onboardingStateSchema });
export type GetOnboardingStateResponse = z.infer<typeof getOnboardingStateResponseSchema>;

export const resumeOnboardingRequestSchema = getOnboardingStateRequestSchema;
export type ResumeOnboardingRequest = GetOnboardingStateRequest;
export const resumeOnboardingResponseSchema = getOnboardingStateResponseSchema;
export type ResumeOnboardingResponse = GetOnboardingStateResponse;

// ---------------------------------------------------------------------------
// Step 1 — Connect Meta (Embedded Signup)
// ---------------------------------------------------------------------------

export const startEmbeddedSignupRequestSchema = z.object({
  accountId: accountIdSchema,
  /** Where Meta's popup returns control to, e.g. `/onboarding/complete` (mobile's controlled deep link, per the spec's "web-first, mobile bridges" section). */
  redirectUri: z.url(),
});
export type StartEmbeddedSignupRequest = z.infer<typeof startEmbeddedSignupRequestSchema>;

export const startEmbeddedSignupResponseSchema = apiResult({ authorizationUrl: z.url() });
export type StartEmbeddedSignupResponse = z.infer<typeof startEmbeddedSignupResponseSchema>;

/** The Embedded Signup popup's callback — exchanges the returned `code` for a long-lived token server-side (never returned to the client). */
export const connectMetaRequestSchema = z.object({
  accountId: accountIdSchema,
  code: z.string().min(1),
});
export type ConnectMetaRequest = z.infer<typeof connectMetaRequestSchema>;

export const connectMetaResponseSchema = apiResult({ state: onboardingStateSchema });
export type ConnectMetaResponse = z.infer<typeof connectMetaResponseSchema>;

/** Admin-assisted fallback: manual credential entry instead of the Embedded Signup popup. */
export const connectMetaManuallyRequestSchema = z.object({
  accountId: accountIdSchema,
  wabaId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  accessToken: z.string().min(1),
});
export type ConnectMetaManuallyRequest = z.infer<typeof connectMetaManuallyRequestSchema>;

export const connectMetaManuallyResponseSchema = apiResult({ state: onboardingStateSchema });
export type ConnectMetaManuallyResponse = z.infer<typeof connectMetaManuallyResponseSchema>;

// ---------------------------------------------------------------------------
// Step 3 — Register phone (2-step-verification PIN via WhatsApp /register)
// ---------------------------------------------------------------------------

export const registerPhoneRequestSchema = z.object({
  accountId: accountIdSchema,
  pin: z.string().regex(/^\d{6}$/, "PIN must be exactly 6 digits"),
});
export type RegisterPhoneRequest = z.infer<typeof registerPhoneRequestSchema>;

export const registerPhoneResponseSchema = apiResult({ state: onboardingStateSchema });
export type RegisterPhoneResponse = z.infer<typeof registerPhoneResponseSchema>;

// ---------------------------------------------------------------------------
// Step 4 — Configure webhook (subscribe + verify handshake)
// ---------------------------------------------------------------------------

export const configureWebhookRequestSchema = z.object({ accountId: accountIdSchema });
export type ConfigureWebhookRequest = z.infer<typeof configureWebhookRequestSchema>;

export const configureWebhookResponseSchema = apiResult({ state: onboardingStateSchema });
export type ConfigureWebhookResponse = z.infer<typeof configureWebhookResponseSchema>;

// ---------------------------------------------------------------------------
// Step 5 — Sync templates (pull existing + require >=1 approved template)
// ---------------------------------------------------------------------------

export const syncTemplatesRequestSchema = z.object({ accountId: accountIdSchema });
export type SyncTemplatesRequest = z.infer<typeof syncTemplatesRequestSchema>;

export const syncTemplatesResponseSchema = apiResult({
  state: onboardingStateSchema,
  importedTemplateCount: z.number().int().min(0),
  approvedTemplateCount: z.number().int().min(0),
});
export type SyncTemplatesResponse = z.infer<typeof syncTemplatesResponseSchema>;

// ---------------------------------------------------------------------------
// Step 6/7 — Health check + complete
// ---------------------------------------------------------------------------

export const completeOnboardingRequestSchema = z.object({ accountId: accountIdSchema });
export type CompleteOnboardingRequest = z.infer<typeof completeOnboardingRequestSchema>;

export const completeOnboardingResponseSchema = apiResult({ state: onboardingStateSchema });
export type CompleteOnboardingResponse = z.infer<typeof completeOnboardingResponseSchema>;

// ---------------------------------------------------------------------------
// The WhatsApp connection, as a settings screen sees it
//
// Deliberately NOT a view over `whatsapp_configs` verbatim: the row's
// `access_token` never appears on the wire in either direction. A screen
// needs to know whether a token is stored, never what it is — so the read
// model carries `hasAccessToken` and nothing else about it. Echoing the token
// back (even masked) would put a tenant's Meta credential into a browser
// cache, a proxy log and a screenshot, for no operator benefit.
// ---------------------------------------------------------------------------

/** Mirrors `WhatsAppRegistrationState` in `modules/whatsapp/application/ports.ts`. */
export const whatsappRegistrationStateSchema = z.enum(["unregistered", "pending", "registered", "failed"]);
export type WhatsappRegistrationState = z.infer<typeof whatsappRegistrationStateSchema>;

export const whatsappConnectionSchema = z.object({
  phoneNumberId: z.string().min(1),
  wabaId: z.string().min(1),
  displayName: z.string().nullable(),
  verifiedName: z.string().nullable(),
  qualityRating: z.string().nullable(),
  registrationState: whatsappRegistrationStateSchema,
  /** Whether a token is on file. Never the token, and never part of it. */
  hasAccessToken: z.boolean(),
  updatedAt: isoDateTimeSchema,
});
export type WhatsappConnection = z.infer<typeof whatsappConnectionSchema>;

export const getWhatsappConnectionResponseSchema = apiResult({
  connection: whatsappConnectionSchema.nullable(),
});
export type GetWhatsappConnectionResponse = z.infer<typeof getWhatsappConnectionResponseSchema>;

/**
 * No `accountId` field, unlike `connectMetaManuallyRequestSchema` above: the
 * tenant is derived from the verified session, never from the request body.
 * Accepting one here would let any authenticated caller name someone else's
 * account and write a token into it.
 */
export const saveWhatsappConnectionRequestSchema = z.object({
  wabaId: z.string().min(1).max(64),
  phoneNumberId: z.string().min(1).max(64),
  accessToken: z.string().min(1).max(1024),
});
export type SaveWhatsappConnectionRequest = z.infer<typeof saveWhatsappConnectionRequestSchema>;

export const saveWhatsappConnectionResponseSchema = apiResult({ connection: whatsappConnectionSchema });
export type SaveWhatsappConnectionResponse = z.infer<typeof saveWhatsappConnectionResponseSchema>;
