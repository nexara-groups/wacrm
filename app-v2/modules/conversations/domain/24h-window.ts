/**
 * The WhatsApp customer-service window (Meta's "24-hour rule").
 *
 * A business may send free-form (non-template) messages to a customer only
 * within 24 hours of that customer's most recent INBOUND message. Once the
 * window closes, Meta rejects free-form sends with error 131047
 * ("re-engagement required") and only an approved template may be used to
 * re-open the conversation.
 *
 * This module is the domain rule *behind* that error: callers that check
 * `isWithinServiceWindow` before sending prevent 131047 rather than having to
 * parse and react to it after the fact (see
 * `modules/messaging-errors/domain/meta-error-codes.ts`'s `131047` entry,
 * which documents the Meta-side symptom this rule exists to avoid).
 *
 * Pure — a function of two timestamps, nothing else. No I/O, no clock reads:
 * callers supply "now" explicitly so this stays deterministic and testable.
 */
import type { ISODateString } from "@packages/domain";

/** The window's length, exactly as Meta defines it. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True when a free-form (non-template) message may still be sent, i.e. `now`
 * is at most 24 hours after `lastInboundAt`.
 *
 * Boundary is INCLUSIVE at exactly 24h: `now - lastInboundAt <= 24h` is
 * within the window, `> 24h` is not. `lastInboundAt === null` (the customer
 * has never messaged in) is always outside the window — there is nothing to
 * measure 24 hours from, so only a template can open the conversation.
 *
 * A `now` that is *before* `lastInboundAt` (clock skew, or a webhook/event
 * processed slightly out of order) is treated as within the window — the
 * inbound message that opened it has, from the caller's point of view,
 * already happened.
 */
export function isWithinServiceWindow(
  lastInboundAt: ISODateString | null,
  now: ISODateString,
): boolean {
  if (lastInboundAt === null) return false;
  const elapsedMs = Date.parse(now) - Date.parse(lastInboundAt);
  if (Number.isNaN(elapsedMs)) return false;
  if (elapsedMs < 0) return true;
  return elapsedMs <= SERVICE_WINDOW_MS;
}

/** Convenience negation — reads better at a template-vs-freeform branch point. */
export function requiresTemplate(lastInboundAt: ISODateString | null, now: ISODateString): boolean {
  return !isWithinServiceWindow(lastInboundAt, now);
}

/**
 * The instant the window closes for a given `lastInboundAt`, or `null` when
 * there is no inbound message to measure from (the window is simply never
 * open). Useful for a UI countdown or for scheduling a "window closing soon"
 * nudge.
 */
export function windowClosesAt(lastInboundAt: ISODateString | null): ISODateString | null {
  if (lastInboundAt === null) return null;
  const closesAtMs = Date.parse(lastInboundAt) + SERVICE_WINDOW_MS;
  if (Number.isNaN(closesAtMs)) return null;
  return new Date(closesAtMs).toISOString();
}

/**
 * Milliseconds remaining in the window as of `now` (clamped to 0, never
 * negative). `null` when there is no window to measure (no inbound message
 * yet).
 */
export function remainingWindowMs(lastInboundAt: ISODateString | null, now: ISODateString): number | null {
  if (lastInboundAt === null) return null;
  const elapsedMs = Date.parse(now) - Date.parse(lastInboundAt);
  if (Number.isNaN(elapsedMs)) return null;
  return Math.max(0, SERVICE_WINDOW_MS - elapsedMs);
}
