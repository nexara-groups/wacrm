/**
 * ConsentState — META_ERROR_TAXONOMY.md §3b, opt-out/DND. Independent of
 * DeliverabilityState: a number can be technically reachable and opted out;
 * both must block a send, for different reasons, with different messages
 * and different reversal rules.
 *
 * This transition table is deliberately kept IN SYNC with the concrete,
 * already-tested transition functions in
 * `modules/messaging-errors/domain/consent.ts` (`optOut`, `markDoNotContact`,
 * `reOptIn`, `clearDoNotContact`) rather than re-deriving the rules from the
 * spec text independently — see this package's SubagentHandback report for
 * the vocabulary-conflict note. In particular:
 *
 *   - `opted_out` (the PERSON's own expressed wish) is reversible ONLY by
 *     the contact themselves (`reOptIn` — a fresh inbound message or an
 *     explicit, evidenced re-opt-in). An "operator" actor can never leave
 *     `opted_out`.
 *   - `do_not_contact` (the BUSINESS's own compliance/DND flag — set by an
 *     operator or at import) IS reversible by an operator (`clearDoNotContact`),
 *     unlike `opted_out`. This is the one place §3b's "not clearable by any
 *     operator" rule does NOT apply verbatim: that sentence describes the
 *     customer's expressed wish, not the business's own flag on top of it.
 *   - Entering `opted_out` or `do_not_contact` is unguarded by the current
 *     state (mirrors `optOut`/`markDoNotContact`, which take no `current`
 *     parameter at all) — a contact can be (re-)marked opted_out or
 *     do_not_contact from any prior state.
 */
export type ConsentState = "unknown" | "opted_in" | "opted_out" | "do_not_contact";

export const CONSENT_STATES: readonly ConsentState[] = [
  "unknown",
  "opted_in",
  "opted_out",
  "do_not_contact",
];

/**
 * Who/what triggered a consent transition.
 *   - "contact"  — the person themself: a new inbound message, an explicit
 *                   re-opt-in, or (as an opt-out trigger) a stop
 *                   keyword/quick-reply they sent.
 *   - "inferred" — system-inferred from behaviour (e.g. repeated delivery
 *                   failure after prior success) — treated as opt-out, not
 *                   technical, per §3b, but is NOT the contact literally
 *                   acting, so it is tracked separately.
 *   - "operator" — a human operator/account owner action.
 *   - "import"   — a CSV/bulk import marking Do-Not-Contact.
 */
export type ConsentActor = "contact" | "operator" | "import" | "inferred";

/** Actors that may move a contact INTO `opted_out` (mirrors `OptOutSource` minus operator/import). */
const OPT_OUT_ACTORS: readonly ConsentActor[] = ["contact", "inferred"];
/** Actors that may move a contact INTO `do_not_contact` (mirrors `OptOutSource`'s operator/import). */
const DO_NOT_CONTACT_ACTORS: readonly ConsentActor[] = ["operator", "import"];

interface TransitionRule {
  readonly to: ConsentState;
  readonly allowedActors: readonly ConsentActor[] | "any";
}

const TRANSITIONS: Record<ConsentState, readonly TransitionRule[]> = {
  unknown: [
    { to: "opted_in", allowedActors: "any" },
    { to: "opted_out", allowedActors: OPT_OUT_ACTORS },
    { to: "do_not_contact", allowedActors: DO_NOT_CONTACT_ACTORS },
  ],
  opted_in: [
    { to: "opted_out", allowedActors: OPT_OUT_ACTORS },
    { to: "do_not_contact", allowedActors: DO_NOT_CONTACT_ACTORS },
  ],
  opted_out: [
    // reOptIn: ONLY the contact themself, never an operator (§3b).
    { to: "opted_in", allowedActors: ["contact"] },
    { to: "do_not_contact", allowedActors: DO_NOT_CONTACT_ACTORS },
  ],
  do_not_contact: [
    // clearDoNotContact: an operator action — the business's own flag.
    { to: "opted_in", allowedActors: ["operator"] },
    { to: "opted_out", allowedActors: OPT_OUT_ACTORS },
  ],
};

/** States that block a marketing/broadcast send (§3b, §4b). */
const SUPPRESSED_STATES: readonly ConsentState[] = ["opted_out", "do_not_contact"];

/**
 * Pure predicate: is `from -> to` a legal ConsentState transition when
 * triggered by `actor`? Encodes both the reachability graph AND the
 * per-transition actor restriction (the "never clearable by an operator"
 * rule for `opted_out`) directly, so callers cannot accidentally build an
 * operator-clears-opt-out code path that merely forgets to check it.
 */
export function canTransitionConsentState(
  from: ConsentState,
  to: ConsentState,
  actor: ConsentActor,
): boolean {
  if (from === to) return false;
  const rule = TRANSITIONS[from].find((r) => r.to === to);
  if (!rule) return false;
  return rule.allowedActors === "any" || rule.allowedActors.includes(actor);
}

export function isSuppressedConsentState(state: ConsentState): boolean {
  return SUPPRESSED_STATES.includes(state);
}

/** True when this consent state must block marketing/broadcast sends (mirrors `blocksSend` in modules/messaging-errors). */
export function consentBlocksSend(state: ConsentState): boolean {
  return isSuppressedConsentState(state);
}
