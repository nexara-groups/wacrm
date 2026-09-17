/**
 * Applies a classified Meta error (from
 * `modules/messaging-errors/domain/meta-error-classifier.ts`'s `classify()`)
 * to a single broadcast recipient. META_ERROR_TAXONOMY.md §5:
 *
 *   TRANSIENT / THROTTLED  -> queue requeue with the computed delay
 *   PERMANENT_CONFIG       -> pause the run + operator alert (never per-contact)
 *   PERMANENT_NUMBER       -> suppress the contact (per-contact, never retried)
 *
 * Pure: given the classification, attempts already made, and "now" (plus an
 * injectable jitter source), returns what to persist on the recipient row
 * AND, separately, what the RUN as a whole must do (`RunEffect`).
 * Suppressing a contact or pausing the whole broadcast are account/run-level
 * side effects this function only DESCRIBES — the application layer is
 * responsible for actually carrying them out through the appropriate port
 * (ContactSuppressionPort / BroadcastRepositoryPort.setPaused +
 * OperatorAlertPort). This keeps the highest-risk decision (does this
 * failure mark 1 contact, or pause 3,000 sends?) in the most testable,
 * I/O-free place.
 *
 * Status modeling note: packages/domain's RecipientStatus has no "retrying"
 * value, and `failed` is its own terminal state — see
 * packages/domain/src/status/recipient-status.ts's `LEGAL_TRANSITIONS`
 * (`failed: []`, no outbound edges at all). A RETRYABLE failure therefore
 * stays `pending` — the recipient is still waiting for its next attempt —
 * with `attemptCount`/`nextAttemptAt` advanced; only a NON-retryable
 * outcome (permanent disposition, or the retry cap reached) moves the
 * recipient to the terminal `failed` status. That is what keeps the
 * existing `pending -> sent` / `pending -> failed` transitions legal at
 * every step of a multi-attempt retry sequence, without inventing a status
 * value the imported vocabulary does not have.
 */
import type { Disposition } from "@packages/domain/src/status/disposition";
import { dispositionSuppressesNumber } from "@packages/domain/src/status/disposition";
import type { RecipientStatus } from "@packages/domain/src/status/recipient-status";
import type { Classification } from "@modules/messaging-errors/domain/meta-error-classifier";
import { computeNextAttempt, type JitterSource } from "@modules/messaging-errors/domain/retry-policy";

/** What the RUN (not just this one recipient) must do as a result of this failure. */
export type RunEffect =
  | { readonly kind: "none" }
  | { readonly kind: "suppress_contact"; readonly reasonCode: string }
  | { readonly kind: "pause_run"; readonly operatorAlert: string; readonly reasonCode: string };

export interface RecipientFailureOutcome {
  readonly status: RecipientStatus;
  /** The Meta error code (or "NETWORK"/"UNKNOWN"/"200-299") — never the raw Meta developer string. */
  readonly errorCode: string;
  /** Customer-facing copy — never a Meta code or Meta's raw text (§4b). */
  readonly errorMessage: string;
  readonly disposition: Disposition;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date | null;
  readonly effect: RunEffect;
}

export interface ApplyRecipientFailureInput {
  /** Attempts already made BEFORE this failure (0 on the very first send attempt). */
  readonly attemptCount: number;
  readonly classification: Classification;
  readonly now: Date;
  /** Injectable jitter source for deterministic tests; defaults to Math.random inside computeNextAttempt. */
  readonly randomSource?: JitterSource;
}

export function applyRecipientFailure(input: ApplyRecipientFailureInput): RecipientFailureOutcome {
  const { classification, attemptCount, now, randomSource } = input;

  const retry = computeNextAttempt(
    { retryMax: classification.retryMax, retryBaseDelaySeconds: classification.retryBaseDelaySeconds },
    attemptCount,
    now,
    randomSource,
  );

  return {
    status: retry.shouldRetry ? "pending" : "failed",
    errorCode: classification.matchedKey,
    errorMessage: classification.laymanMessage,
    disposition: classification.disposition,
    attemptCount: attemptCount + 1,
    nextAttemptAt: retry.nextAttemptAt,
    effect: deriveRunEffect(classification),
  };
}

function deriveRunEffect(classification: Classification): RunEffect {
  // Only PERMANENT_NUMBER ever suppresses the CONTACT (a per-contact
  // fault). Reuses the exact predicate packages/domain ships for this rule
  // instead of re-deriving it, so there is one place — not two — that
  // decides "does this disposition mark a number" (disposition.ts's own
  // docstring: "Only PERMANENT_NUMBER ever marks/suppresses the recipient's
  // number").
  if (dispositionSuppressesNumber(classification.disposition)) {
    return { kind: "suppress_contact", reasonCode: classification.matchedKey };
  }

  // PERMANENT_CONFIG is OUR fault, per-account — retrying it on other
  // numbers fails identically. Pause the whole run and alert the operator
  // instead of marking every remaining recipient bad for a broken
  // template/token (spec §2, §5). Never suppresses a contact.
  if (classification.disposition === "PERMANENT_CONFIG") {
    return {
      kind: "pause_run",
      operatorAlert: classification.operatorHint,
      reasonCode: classification.matchedKey,
    };
  }

  // TRANSIENT / THROTTLED — no run- or contact-level side effect beyond
  // the retry already encoded in `status`/`nextAttemptAt` above.
  return { kind: "none" };
}
