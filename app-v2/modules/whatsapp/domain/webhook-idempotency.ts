/**
 * Webhook idempotency — Meta redelivers webhooks (at-least-once delivery;
 * a slow ack, a transient 5xx, or Meta's own retry policy all produce a
 * second POST for the same underlying event). META_ERROR_TAXONOMY.md §6:
 * "Duplicate webhook for the same message suppresses once, logs once
 * (idempotent)".
 *
 * The actual dedup guarantee is a DB-level `UNIQUE(account_id, event_id)`
 * constraint on the append-only `whatsapp_webhook_events` table (migration
 * 0006) — a race between two concurrent deliveries of the same event must
 * be closed atomically, and only a real unique constraint can do that
 * (a read-then-write check alone cannot, under concurrent delivery). This
 * module supplies the two pieces of PURE logic around that guarantee:
 *   1. the deterministic key an event claims, so the same underlying event
 *      always attempts the same row regardless of how many times it is
 *      redelivered;
 *   2. the decision of what a claim attempt's outcome means for the caller.
 *
 * `infrastructure/whatsapp-repository.ts` implements the actual atomic
 * claim (`INSERT ... ON CONFLICT DO NOTHING` / `INSERT OR IGNORE`, keyed on
 * this id) and reports back whether ITS call was the one that inserted the
 * row; `application/whatsapp-service.ts` only classifies, suppresses, and
 * logs when that report says `isNew: true` — so "classify once, suppress
 * once, log once" falls directly out of "only the winning insert proceeds".
 */
import type { ParsedWebhookEvent } from "./webhook-parser";

/**
 * Deterministic id for one parsed webhook event, stable across redeliveries
 * of the SAME underlying event and distinct across genuinely different
 * events:
 *   - An inbound message is identified by its own Meta message id — Meta
 *     never reuses a `wamid` for two different inbound messages.
 *   - A status update is identified by (message id, status value) — a
 *     single outbound message legitimately produces several DIFFERENT
 *     status events over its life (sent, then delivered, then read), each
 *     of which is its own event and must be processed once each; only a
 *     REDELIVERY of e.g. the same "delivered" event is a duplicate.
 */
export function computeWebhookEventId(event: ParsedWebhookEvent): string {
  switch (event.kind) {
    case "inbound_message":
      return `msg:${event.waMessageId}`;
    case "status_update":
      return `status:${event.waMessageId}:${event.status}`;
  }
}

/**
 * Pure decision from a claim attempt's outcome: only the delivery that
 * actually inserted the idempotency row (`isNew`) should go on to
 * classify/suppress/log. Every subsequent redelivery of the same event
 * finds the row already there and must no-op.
 *
 * Trivial by design — the identity function — but named and exported so
 * every call site reads as an explicit domain decision ("should this
 * delivery process the event?") rather than an inline `if (isNew)`, and so
 * the decision has exactly one place to change if it is ever more than an
 * identity function.
 */
export function shouldProcessWebhookEvent(claim: { readonly isNew: boolean }): boolean {
  return claim.isNew;
}
