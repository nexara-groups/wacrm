/**
 * Onboarding-specific failure -> plain-English guidance.
 *
 * Per META_ERROR_TAXONOMY.md §4b "Writing rules":
 *   No Meta error codes in user-facing text
 *   No jargon: no "WABA", "hydrated", "parameter", "subcode", "24-hour window"
 *   Say what happened, then what happens next — and whether the user must act
 *   Never blame the user for Meta-side problems
 *
 * Onboarding is called out in the build brief as the highest-stakes place
 * for this copy: "Onboarding is where a confused customer abandons, so the
 * copy matters more here than anywhere."
 *
 * Every Meta-provider-shaped failure is classified by
 * `modules/messaging-errors`'s `classify()` — imported and reused, NOT
 * reimplemented (per §5 of that spec: "MetaErrorClassifier is domain-layer
 * and vendor-free... satisfies the architecture guard"). This file adds only
 * the onboarding-specific failure kinds that never reach a Meta API at all
 * (an illegal wizard jump, an expired resume link, a missing PIN) — those
 * have no Meta error code to classify and need their own copy.
 */
import { classify, type MetaError } from "@modules/messaging-errors/domain/meta-error-classifier";
import { isPermanent } from "@modules/messaging-errors/domain/disposition";
import type { OnboardingEventType, OnboardingState } from "./onboarding-state-machine";

export type OnboardingFailureReason =
  | { readonly kind: "meta_provider_error"; readonly error: MetaError }
  | { readonly kind: "illegal_transition"; readonly from: OnboardingState; readonly event: OnboardingEventType }
  | { readonly kind: "session_not_found" }
  | { readonly kind: "connection_not_found" }
  | { readonly kind: "invalid_resume_token" }
  | { readonly kind: "already_complete" }
  | { readonly kind: "missing_verification_pin" }
  | { readonly kind: "no_approved_template" };

export interface OnboardingGuidance {
  /** Customer-facing copy. Contains no Meta code and no raw Meta text. */
  readonly laymanMessage: string;
  /** Operator/support-facing copy. May reference Meta's own terminology. */
  readonly operatorHint: string;
  /** Whether retrying the SAME step, unchanged, might succeed. */
  readonly retryable: boolean;
}

/** Compile-time exhaustiveness guard, same discipline as the state machine. */
function assertExhaustiveReason(value: never): never {
  throw new Error(`Unhandled OnboardingFailureReason: ${JSON.stringify(value)}`);
}

/**
 * Translate a failure into copy safe to show a customer plus a technical
 * hint for support/the account owner. Total — never throws.
 */
export function describeOnboardingFailure(reason: OnboardingFailureReason): OnboardingGuidance {
  switch (reason.kind) {
    case "meta_provider_error": {
      // Reuse verbatim: classify() already guarantees jargon-free,
      // code-free customer copy (META_ERROR_TAXONOMY.md §4b) — writing a
      // second version here would be exactly the "second error taxonomy"
      // the build brief forbids.
      const classification = classify(reason.error);
      return {
        laymanMessage: classification.laymanMessage,
        operatorHint: `During onboarding: ${classification.operatorHint}`,
        retryable: !isPermanent(classification.disposition),
      };
    }
    case "illegal_transition":
      return {
        laymanMessage: "That step isn't available right now. Go back and pick up where you left off.",
        operatorHint: `Illegal onboarding transition attempted: event "${reason.event}" from state "${reason.from}".`,
        retryable: false,
      };
    case "session_not_found":
      return {
        laymanMessage: "We couldn't find your setup session. Start connecting your WhatsApp Business account again.",
        operatorHint: "onboarding_sessions lookup returned no row for this account/resume token.",
        retryable: false,
      };
    case "connection_not_found":
      return {
        laymanMessage: "We couldn't find your Meta Business connection details. Reconnect your account to continue.",
        operatorHint: "meta_business_connections lookup returned no row for this account, though the session had already progressed past connecting Meta.",
        retryable: false,
      };
    case "invalid_resume_token":
      return {
        laymanMessage: "This setup link has expired or was already used. Start connecting your WhatsApp Business account again.",
        operatorHint: "resume_token did not match any active onboarding_sessions row for this account.",
        retryable: false,
      };
    case "already_complete":
      return {
        laymanMessage: "Your WhatsApp Business connection is already set up.",
        operatorHint: "A transition was attempted on a session already in the complete state.",
        retryable: false,
      };
    case "missing_verification_pin":
      return {
        laymanMessage:
          "We need the two-step verification PIN for this number to finish connecting it. Enter it to continue.",
        operatorHint:
          "registerPhoneNumber called without a pin. Meta requires the 2FA PIN set in WhatsApp Manager -> Two-step verification.",
        retryable: true,
      };
    case "no_approved_template":
      return {
        laymanMessage: "You'll need at least one approved message template before setup can finish.",
        operatorHint: "markTemplatesReady called with an approved-template count of zero.",
        retryable: true,
      };
    default:
      return assertExhaustiveReason(reason);
  }
}
