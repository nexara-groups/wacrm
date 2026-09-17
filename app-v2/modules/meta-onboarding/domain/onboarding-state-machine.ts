/**
 * Onboarding state machine — the Embedded Signup wizard, modelled per
 * `docs/rebuild discussion/phase-0/META_ONBOARDING_FLOW.md` §"State machine":
 *
 *   created -> meta_connected -> phone_registered -> webhook_verified
 *           -> template_ready -> complete
 *
 * Pure — no I/O, no vendor imports, no DB. Every function here takes its
 * "now" from an injectable clock so tests are deterministic.
 *
 * RESUME RULE (the load-bearing requirement): "onboarding is interrupted
 * constantly (a person closes the tab mid-Facebook-popup), so every state
 * must be resumable." Two consequences follow, both encoded below:
 *
 *   1. Every NON-TERMINAL state accepts a `RECORD_FAILURE` event that does
 *      NOT change the state (a self-loop). A failed provider call therefore
 *      never strands the account somewhere it cannot leave — the very next
 *      call from the same state (the step that just failed) is legal again.
 *      This is the "failure/retry states required" requirement from the
 *      spec: it is satisfied by making failure a recorded, legal, NO-OP
 *      transition rather than inventing a maze of "*_failed" states that
 *      would each need their own way back in.
 *   2. `resumeStep` is a total function over every state (including
 *      `complete`) that says exactly which step a returning user should be
 *      dropped back into — the persisted `state` column IS the resume
 *      pointer; there is no separate "progress" field to fall out of sync
 *      with it.
 */
import { err, ok, type Result } from "@shared/result";
import { AppError } from "@shared/errors";

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** Exhaustive tuple of every onboarding state — the single source of truth
 *  for the `OnboardingState` union below and for `db/migrations/*/0010_meta_onboarding.sql`'s
 *  `CHECK (state IN (...))` constraint, which must be kept in sync by hand
 *  (SQL has no way to import a TypeScript const). */
export const ONBOARDING_STATES = [
  "created",
  "meta_connected",
  "phone_registered",
  "webhook_verified",
  "template_ready",
  "complete",
] as const;

export type OnboardingState = (typeof ONBOARDING_STATES)[number];

/** `complete` is the only terminal state — see module docstring: every other
 *  state is resumable, including by definition every non-terminal one. */
export const TERMINAL_STATES: readonly OnboardingState[] = ["complete"];

export function isTerminal(state: OnboardingState): boolean {
  return state === "complete";
}

export function isOnboardingState(value: string): value is OnboardingState {
  return (ONBOARDING_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * One event per guided step in META_ONBOARDING_FLOW.md §"Guided steps"
 * (steps 2 "store identifiers" and 6 "health check" are folded into
 * `CONNECT_META` and `COMPLETE` respectively — they are sub-actions of the
 * step either side of them, not separate WABA/Meta operations of their own),
 * plus the universal `RECORD_FAILURE` self-loop described above.
 */
export type OnboardingEventType =
  | "CONNECT_META"
  | "REGISTER_PHONE"
  | "VERIFY_WEBHOOK"
  | "SYNC_TEMPLATES"
  | "COMPLETE"
  | "RECORD_FAILURE";

export type OnboardingEvent =
  | { readonly type: "CONNECT_META" }
  | { readonly type: "REGISTER_PHONE" }
  | { readonly type: "VERIFY_WEBHOOK" }
  | { readonly type: "SYNC_TEMPLATES" }
  | { readonly type: "COMPLETE" }
  | { readonly type: "RECORD_FAILURE"; readonly reason: string };

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** Injectable clock — tests pass a fixed `() => new Date(...)`. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * The only legal FORWARD transitions. Deliberately a `Record` keyed by every
 * `OnboardingState` (not a partial map) — adding a new state to
 * `ONBOARDING_STATES` without adding its row here is a TypeScript compile
 * error, which is exactly the "exhaustive over its state union" guarantee
 * item 8 of the build asks for; see also `assertExhaustiveState` below,
 * which gives the same guarantee inside `transition`'s switch.
 *
 * Each state advances on exactly one event to exactly one next state — the
 * flow is strictly linear and non-skippable, matching the spec's arrow
 * diagram verbatim. `complete` has no forward transition at all.
 */
const FORWARD_TRANSITIONS: Record<OnboardingState, { readonly on: OnboardingEventType; readonly to: OnboardingState } | null> = {
  created: { on: "CONNECT_META", to: "meta_connected" },
  meta_connected: { on: "REGISTER_PHONE", to: "phone_registered" },
  phone_registered: { on: "VERIFY_WEBHOOK", to: "webhook_verified" },
  webhook_verified: { on: "SYNC_TEMPLATES", to: "template_ready" },
  template_ready: { on: "COMPLETE", to: "complete" },
  complete: null,
};

export interface TransitionResult {
  readonly state: OnboardingState;
  readonly previousState: OnboardingState;
  /** `false` for a `RECORD_FAILURE` self-loop — the persisted `state` column
   *  does not need to move, only `last_error`/`updated_at` do. */
  readonly changed: boolean;
  readonly event: OnboardingEventType;
  readonly occurredAt: Date;
}

/** Compile-time exhaustiveness guard — see `ONBOARDING_STATES` docstring. */
function assertExhaustiveState(value: never): never {
  throw AppError.validation(`Unhandled OnboardingState: ${String(value)}`);
}

/**
 * Apply `event` to `current`. Total and pure: never throws, always returns a
 * `Result`. Illegal jumps (skipping a step, moving backward, acting on the
 * wrong event for the state, or any event at all once `complete`) resolve to
 * `err(...)` rather than a throw, so callers (the application service) can
 * turn that into the onboarding-errors plain-English guidance uniformly,
 * the same way every other failure in this module is handled.
 */
export function transition(current: OnboardingState, event: OnboardingEvent, clock: Clock = systemClock): Result<TransitionResult, AppError> {
  const now = clock();

  // RECORD_FAILURE is legal from every non-terminal state and never moves
  // the state — see module docstring, resume rule consequence 1.
  if (event.type === "RECORD_FAILURE") {
    if (isTerminal(current)) {
      return err(AppError.validation(`Cannot record a failure once onboarding is complete (state: ${current})`));
    }
    return ok({ state: current, previousState: current, changed: false, event: event.type, occurredAt: now });
  }

  switch (current) {
    case "created":
    case "meta_connected":
    case "phone_registered":
    case "webhook_verified":
    case "template_ready": {
      const forward = FORWARD_TRANSITIONS[current];
      if (forward && forward.on === event.type) {
        return ok({ state: forward.to, previousState: current, changed: true, event: event.type, occurredAt: now });
      }
      return err(
        AppError.validation(
          `Illegal onboarding transition: cannot apply "${event.type}" from state "${current}"` +
            (forward ? ` (expected "${forward.on}")` : ""),
        ),
      );
    }
    case "complete":
      return err(AppError.validation(`Illegal onboarding transition: onboarding is already complete, cannot apply "${event.type}"`));
    default:
      return assertExhaustiveState(current);
  }
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export interface ResumeStep {
  readonly state: OnboardingState;
  /** The event a resumed session should attempt next. `null` once terminal
   *  — there is nothing left to resume into. */
  readonly nextEvent: OnboardingEventType | null;
  /** Short, UI-facing label for "what happens if you continue from here" —
   *  no Meta jargon (see domain/onboarding-errors.ts for the same rule
   *  applied to failure copy). */
  readonly label: string;
}

const RESUME_LABELS: Record<OnboardingState, string> = {
  created: "Connect your WhatsApp Business account",
  meta_connected: "Register your WhatsApp number",
  phone_registered: "Confirm your message setup",
  webhook_verified: "Sync your message templates",
  template_ready: "Finish setup",
  complete: "Setup complete",
};

/**
 * Total function over every state (resume rule consequence 2, module
 * docstring). Every non-terminal state resumes into the forward transition
 * it is currently sitting in front of — the same event a fresh attempt from
 * that state would use, so `resumeStep(state).nextEvent` is always a legal
 * `event.type` to hand to `transition(state, ...)`.
 */
export function resumeStep(state: OnboardingState): ResumeStep {
  const forward = FORWARD_TRANSITIONS[state];
  return { state, nextEvent: forward ? forward.on : null, label: RESUME_LABELS[state] };
}

export function isResumable(state: OnboardingState): boolean {
  return !isTerminal(state);
}
