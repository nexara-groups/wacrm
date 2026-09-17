/**
 * DeliverabilityState — META_ERROR_TAXONOMY.md §4, "number suppression".
 * Technical reachability of a phone number, as distinct from consent
 * (see consent-state.ts) — a number can be technically reachable and opted
 * out at the same time; both independently block a send.
 *
 * State machine (verbatim from §4):
 *   unknown          --first success-->        reachable
 *   unknown          --PERMANENT_NUMBER-->      suppressed
 *   reachable        --PERMANENT_NUMBER-->      suppressed
 *   suppressed       --operator override-->     manually_cleared   (strikes reset to 0)
 *   manually_cleared --PERMANENT_NUMBER-->      suppressed         (immediate; no second grace)
 */
export type DeliverabilityState = "unknown" | "reachable" | "suppressed" | "manually_cleared";

export const DELIVERABILITY_STATES: readonly DeliverabilityState[] = [
  "unknown",
  "reachable",
  "suppressed",
  "manually_cleared",
];

/** What caused a deliverability transition to be attempted. */
export type DeliverabilityTrigger = "send_success" | "permanent_number_error" | "operator_override";

const LEGAL_TRANSITIONS: Record<
  DeliverabilityState,
  Partial<Record<DeliverabilityTrigger, DeliverabilityState>>
> = {
  unknown: { send_success: "reachable", permanent_number_error: "suppressed" },
  reachable: { permanent_number_error: "suppressed" },
  suppressed: { operator_override: "manually_cleared" },
  manually_cleared: { permanent_number_error: "suppressed" },
};

/** Pure predicate: is `from -> to` a legal DeliverabilityState transition for the given trigger? */
export function canTransitionDeliverabilityState(
  from: DeliverabilityState,
  to: DeliverabilityState,
  trigger: DeliverabilityTrigger,
): boolean {
  return LEGAL_TRANSITIONS[from][trigger] === to;
}

/** Resolves the next state for a trigger, or `undefined` if that trigger has no effect from `from`. */
export function nextDeliverabilityState(
  from: DeliverabilityState,
  trigger: DeliverabilityTrigger,
): DeliverabilityState | undefined {
  return LEGAL_TRANSITIONS[from][trigger];
}
