/**
 * ConsentState — META_ERROR_TAXONOMY.md §3b, opt-out/DND. Independent of
 * DeliverabilityState: a number can be technically reachable and opted out;
 * both must block a send, for different reasons, with different messages
 * and different reversal rules.
 *
 * The rule that matters (§3b): "Opt-out is NOT clearable by any operator —
 * only a new inbound message from that person, or an explicit re-opt-in,
 * restores sending." This is why the transition predicate below takes the
 * triggering `actor` — the same `unknown -> opted_in` shape of transition
 * is legal for `opted_out -> opted_in` too, but ONLY when the actor is the
 * contact themselves (never "operator").
 */
export type ConsentState = "unknown" | "opted_in" | "opted_out" | "do_not_contact";

export const CONSENT_STATES: readonly ConsentState[] = [
  "unknown",
  "opted_in",
  "opted_out",
  "do_not_contact",
];

/** Mirrors `opt_out_source` (§3b) plus "contact" for an explicit re-opt-in/new inbound message. */
export type ConsentActor = "contact" | "operator" | "import" | "inferred";

const REACHABLE_TARGETS: Record<ConsentState, readonly ConsentState[]> = {
  unknown: ["opted_in", "opted_out", "do_not_contact"],
  opted_in: ["opted_out", "do_not_contact"],
  opted_out: ["opted_in", "do_not_contact"],
  do_not_contact: ["opted_in", "opted_out"],
};

/** States a contact can only ever be moved OUT of by their own action (§3b). */
const SUPPRESSED_STATES: readonly ConsentState[] = ["opted_out", "do_not_contact"];

/**
 * Pure predicate: is `from -> to` a legal ConsentState transition when
 * triggered by `actor`? Encodes the "never clearable by an operator" rule
 * directly, so callers cannot accidentally build an operator-clears-opt-out
 * code path that merely forgets to check it.
 */
export function canTransitionConsentState(
  from: ConsentState,
  to: ConsentState,
  actor: ConsentActor,
): boolean {
  if (from === to) return false;
  if (!REACHABLE_TARGETS[from].includes(to)) return false;

  const leavingSuppressed = SUPPRESSED_STATES.includes(from) && !SUPPRESSED_STATES.includes(to);
  if (leavingSuppressed && actor !== "contact") {
    // Only the contact themself (a new inbound message, or an explicit,
    // evidenced re-opt-in) may clear opted_out / do_not_contact.
    return false;
  }
  return true;
}

export function isSuppressedConsentState(state: ConsentState): boolean {
  return SUPPRESSED_STATES.includes(state);
}
