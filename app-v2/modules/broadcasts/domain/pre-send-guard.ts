/**
 * Pre-send guard — META_ERROR_TAXONOMY.md §4 enforcement point 2, and §3b's
 * "opt-out check runs BEFORE credit reservation".
 *
 * Re-checks suppression AND consent immediately before dispatch, because a
 * concurrent campaign (or an inbound STOP reply arriving between audience
 * build and this recipient's turn in the queue) may have changed either
 * state since `domain/audience.ts` built the send list. This calls the SAME
 * `shouldBlockSend` primitive `audience.ts` uses — one rule, not two copies
 * that can silently drift apart — but it MUST be called again here against
 * a freshly-read contact state, never the snapshot the audience preview
 * used.
 *
 * ORDERING REQUIREMENT (spec §4 enforcement point 2 and §3b — load-bearing,
 * do not reorder):
 *
 *   1. pre-send guard (THIS module)   — suppression + consent, fresh read
 *   2. credit reservation             — NOT BUILT. Gated behind both hard
 *      gates in DO_NOT_BUILD_YET.md (see META_ERROR_TAXONOMY.md §7: "the
 *      credit-interaction part ... touches reservation code, which
 *      DO_NOT_BUILD_YET.md gates behind both hard gates"). "This check runs
 *      before the credit reservation, so a suppressed number never consumes
 *      credits" and "opt-out check runs before credit reservation — an
 *      opted-out number never consumes credits" are both explicit in spec.
 *   3. dispatch to the WhatsApp provider
 *
 * See the EXTENSION POINT comment block at the bottom of this file for
 * exactly where step 2 must be inserted once it is allowed to be built.
 * This module defines no credit/ledger/reservation/settlement type or
 * function — that is explicitly forbidden right now.
 */
import { shouldBlockSend, type BlockReason } from "@modules/messaging-errors/domain/suppression";
import type { ConsentState } from "@packages/domain/src/status/consent-state";
import type { DeliverabilityState } from "@packages/domain/src/status/deliverability-state";

export interface PreSendCheckInput {
  readonly deliverabilityState: DeliverabilityState;
  readonly consentState: ConsentState;
  readonly suppressedReasonCode?: string;
}

export type PreSendDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: BlockReason; readonly message: string };

/**
 * Plain-English copy for a blocked pre-send check, verbatim from
 * META_ERROR_TAXONOMY.md §3b / §4 — never paraphrase here; edit the spec
 * first, then this table, mirroring `meta-error-codes.ts`'s own rule for
 * Meta error copy.
 */
function messageFor(reason: BlockReason): string {
  switch (reason.kind) {
    case "suppressed":
      return "This number can't receive WhatsApp messages. We've stopped sending to it.";
    case "opted_out":
      return "This person asked to stop receiving messages. You can't message them until they contact you again.";
    case "do_not_contact":
      return "This contact is marked do-not-contact and has been skipped.";
  }
}

/**
 * Pure decision function — no I/O. The caller is responsible for:
 *   (a) reading `input` fresh, immediately before calling this, never from
 *       any cache or the audience-build snapshot; and
 *   (b) never reserving credits and never calling the WhatsApp provider
 *       until this returns `{ allowed: true }`.
 */
export function preSendGuard(input: PreSendCheckInput): PreSendDecision {
  const block = shouldBlockSend(input.deliverabilityState, input.consentState, input.suppressedReasonCode);
  if (block === null) return { allowed: true };
  return { allowed: false, reason: block, message: messageFor(block) };
}

// ---------------------------------------------------------------------------
// EXTENSION POINT — credit reservation. DO NOT IMPLEMENT HERE; gated (see
// header). This is a documentation-only marker, deliberately not an
// interface or port stub, so nothing in this file can be mistaken for a
// partial implementation of gated functionality.
//
// The future call site (in application/broadcast-service.ts's dispatch
// loop, once the credit/ledger gates in DO_NOT_BUILD_YET.md clear) must
// read:
//
//   const decision = preSendGuard(freshContactState);
//   if (!decision.allowed) { recordBlockedOutcome(decision); continue; }
//   const reservation = await creditReservationPort.reserve(accountId, 1); // NOT BUILT
//   if (!reservation.ok) { ...; continue; }
//   const result = await dispatchPort.sendTemplateMessage(...);
//
// The reservation call MUST sit strictly between `preSendGuard` returning
// `allowed: true` and the dispatch call — never before the guard.
// ---------------------------------------------------------------------------
