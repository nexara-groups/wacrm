/**
 * Turns parsed inbound WhatsApp events into inbox messages.
 *
 * This lives in the web layer, not in a module, because it is the seam
 * between two modules that deliberately do not know about each other:
 * `modules/whatsapp` parses and classifies what Meta sent, and
 * `modules/conversations` owns threads and unread counts. Teaching either
 * one about the other would couple them for the sake of one call site.
 *
 * It exists because `WhatsAppService.processWebhookEvent` handles only
 * DELIVERABILITY — a failed status update gets classified and can suppress a
 * contact — and does nothing with an inbound message beyond claiming its
 * event id for idempotency. The webhook therefore answered `processed: 1`
 * while the inbox stayed empty. Receiving a message and storing it are two
 * different things, and only one of them was happening.
 *
 * A DURABILITY HAZARD worth naming, because the fix is not local: the event
 * is claimed by `processWebhookEvent` BEFORE this function runs. If the
 * process dies in between, Meta's redelivery is deduped by that claim and
 * the message is lost for good. `InboxService.recordInbound` is itself
 * idempotent on `waMessageId`, so duplicates are harmless and the claim
 * buys nothing here that the message insert does not already provide — the
 * real fix is to stop claiming inbound-message events ahead of storing
 * them. That belongs in the whatsapp module's own service and is not done
 * here; this function returns per-event failures so a caller can at least
 * see it happen rather than reporting success.
 */
import { InboxService } from "@modules/conversations/application/inbox-service";
import type { ModuleRepositories } from "@modules/container";
import type { WebhookProcessingOutcome } from "@modules/whatsapp/application/whatsapp-service";
import type { TenantContext } from "@nexara/core/context";
import type { PhoneNumber } from "@packages/domain";
import { parsePhoneNumber } from "@packages/domain";

export interface InboundRecordingResult {
  /** Messages actually written to a conversation. */
  readonly stored: number;
  /** Events that should have been stored and were not, with the reason. */
  readonly failures: readonly string[];
}

/**
 * Maps Meta's message type onto the wire/domain vocabulary. Anything not
 * modelled becomes `system` rather than being dropped: an unrecognised type
 * is still a real message the customer sent, and an empty thread is a worse
 * answer than a typed placeholder.
 */
function toMessageType(metaType: string): "text" | "template" | "media" | "interactive" | "system" {
  switch (metaType) {
    case "text":
      return "text";
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return "media";
    case "button":
    case "interactive":
      return "interactive";
    default:
      return "system";
  }
}

export async function recordInboundMessages(
  repositories: ModuleRepositories,
  accountId: string,
  outcomes: readonly WebhookProcessingOutcome[],
): Promise<InboundRecordingResult> {
  const inbound = outcomes.filter((o) => !o.deduped && o.event.kind === "inbound_message");
  if (inbound.length === 0) return { stored: 0, failures: [] };

  const tenant: TenantContext = { tenantId: accountId as never };
  const inbox = new InboxService({
    conversations: repositories.conversations,
    messages: repositories.messages,
  });

  let stored = 0;
  const failures: string[] = [];

  for (const outcome of inbound) {
    const event = outcome.event;
    if (event.kind !== "inbound_message") continue;

    // Meta sends `from` as digits with no `+`. Normalising through the same
    // parser the rest of the app uses is what makes a webhook contact and a
    // CSV-imported contact resolve to the SAME row — which is what keeps a
    // consent decision attached to a person rather than to a spelling.
    let phone: PhoneNumber;
    try {
      phone = parsePhoneNumber(event.from.startsWith("+") ? event.from : `+${event.from}`) as PhoneNumber;
    } catch (error) {
      failures.push(`${event.waMessageId}: unparseable sender ${event.from}`);
      continue;
    }

    try {
      const contact =
        (await repositories.contacts.findByPhone(tenant, phone)) ??
        (await repositories.contacts.create(tenant, {
          phoneNumber: phone,
          displayName: null,
          email: null,
          company: null,
        }));

      const result = await inbox.recordInbound(tenant, contact.id, {
        type: toMessageType(event.messageType),
        body: event.text,
        templateId: null,
        waMessageId: event.waMessageId,
        replyToId: null,
        mediaRef: null,
        status: "delivered",
        occurredAt: new Date(Number(event.timestamp) * 1000).toISOString(),
      });

      if (result.ok) stored += 1;
      else failures.push(`${event.waMessageId}: ${result.error.message}`);
    } catch (error) {
      failures.push(`${event.waMessageId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { stored, failures };
}
