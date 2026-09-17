/**
 * Number suppression — the deliverability state machine. See spec §4.
 *
 *   unknown ──first success──────────────→ reachable
 *   unknown ──PERMANENT_NUMBER───────────→ suppressed
 *   reachable ──PERMANENT_NUMBER─────────→ suppressed
 *   suppressed ──operator override───────→ manually_cleared (strikes reset to 0)
 *   manually_cleared ──PERMANENT_NUMBER──→ suppressed        (immediate; no second grace)
 *
 * `deliverability_state` is a SEPARATE axis from `consent_state` (see
 * domain/consent.ts) — a contact can be technically reachable and opted
 * out; both block sending, for different reasons, with different reversal
 * rules. `shouldBlockSend` below is the single place both axes are
 * combined for a send-time decision.
 */
import { err, ok, type Result } from "@shared/result";
import { AppError } from "@shared/errors";
import type { ConsentState } from "./consent";

export type DeliverabilityState = "unknown" | "reachable" | "suppressed" | "manually_cleared";

/**
 * Hard codes that suppress immediately on first occurrence — no strikes,
 * no grace. Spec §4: "these are definitive." Codes as strings to match
 * MetaErrorCodeEntry.code / Classification.matchedKey.
 */
const HARD_SUPPRESSION_CODES: ReadonlySet<string> = new Set(["131026", "131021"]);

export function isHardSuppressionCode(code: string): boolean {
  return HARD_SUPPRESSION_CODES.has(code);
}

export interface DeliverabilityRecord {
  readonly state: DeliverabilityState;
  readonly suppressedAt?: Date;
  /** The Meta error code (as a string) that caused the current/last
   *  suppression, e.g. "131026". */
  readonly suppressedReasonCode?: string;
  /** Counts suppression occurrences; reset to 0 on a manual clear. Exists
   *  for future ambiguous codes and for detecting repeat failures on a
   *  manually-cleared number — the hard codes above suppress on strike 1
   *  regardless. */
  readonly suppressionStrikes: number;
}

export const UNKNOWN_DELIVERABILITY: DeliverabilityRecord = {
  state: "unknown",
  suppressionStrikes: 0,
};

/**
 * A successful delivery. Only `unknown` transitions (to `reachable`) — a
 * success does not un-suppress a suppressed or manually-cleared number by
 * itself; that requires an explicit operator override via `clearSuppression`.
 * In practice the pre-send guard (spec §4, enforcement point 2) should
 * prevent a send attempt reaching a suppressed number at all, but this
 * function stays defensive/pure regardless of caller discipline.
 */
export function recordSuccess(current: DeliverabilityRecord): DeliverabilityRecord {
  if (current.state === "unknown") {
    return { ...current, state: "reachable" };
  }
  return current;
}

/**
 * A PERMANENT_NUMBER failure. Suppresses from any state, including
 * `manually_cleared` — which re-suppresses immediately, with NO second
 * grace period (spec §4 state machine, and "A cleared number that
 * immediately fails again re-suppresses with no grace period").
 */
export function recordPermanentNumberFailure(
  current: DeliverabilityRecord,
  reasonCode: string,
  at: Date,
): DeliverabilityRecord {
  const strikes = current.state === "manually_cleared" ? 1 : current.suppressionStrikes + 1;
  return {
    state: "suppressed",
    suppressedAt: at,
    suppressedReasonCode: reasonCode,
    suppressionStrikes: strikes,
  };
}

/**
 * Operator override: suppressed -> manually_cleared, strikes reset to 0.
 * Only valid from `suppressed` (spec §4 diagram has no other inbound edge
 * to `manually_cleared`). Returns a Result since calling it from any other
 * state is a precondition violation, not a valid domain transition.
 */
export function clearSuppression(current: DeliverabilityRecord): Result<DeliverabilityRecord> {
  if (current.state !== "suppressed") {
    return err(
      AppError.validation(
        `Cannot clear suppression from state "${current.state}" — only a "suppressed" number can be cleared`,
      ),
    );
  }
  return ok({
    state: "manually_cleared",
    suppressedAt: undefined,
    suppressedReasonCode: undefined,
    suppressionStrikes: 0,
  });
}

/**
 * Why a send is blocked. `kind` distinguishes the two independent axes
 * (technical deliverability vs. consent) since they carry different
 * messaging and different reversal rules — see spec §3b and §4b.
 */
export type BlockReason =
  | { readonly kind: "suppressed"; readonly reasonCode?: string }
  | { readonly kind: "opted_out" }
  | { readonly kind: "do_not_contact" };

/**
 * Pure send-time gate combining BOTH axes. Consent is checked first because
 * it is the stricter, non-operator-reversible reason, but callers should
 * not rely on ordering when both happen to be true simultaneously — treat
 * this as "blocked or not", with `BlockReason` explaining why for display
 * purposes (spec §4b surfaces the reason to the user before they even hit
 * send).
 */
export function shouldBlockSend(
  deliverability: DeliverabilityState,
  consent: ConsentState,
  reasonCode?: string,
): BlockReason | null {
  if (consent === "do_not_contact") return { kind: "do_not_contact" };
  if (consent === "opted_out") return { kind: "opted_out" };
  if (deliverability === "suppressed") return { kind: "suppressed", reasonCode };
  return null;
}
