import { describe, expect, it } from "vitest";
import { classifyMetaFailure, toProviderFailure } from "./meta-error-mapping";
import { parseWebhookEnvelope, type WebhookEnvelope } from "./webhook-parser";

function envelopeWithStatus(status: Record<string, unknown>): WebhookEnvelope {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "phone-1" },
              statuses: [status],
            },
          },
        ],
      },
    ],
  };
}

describe("parseWebhookEnvelope — inbound messages", () => {
  it("parses a plain text message", () => {
    const envelope: WebhookEnvelope = {
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                contacts: [{ profile: { name: "Ada" }, wa_id: "15551234567" }],
                messages: [
                  { id: "wamid.1", from: "15551234567", timestamp: "1700000000", type: "text", text: { body: "hi" } },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = parseWebhookEnvelope(envelope);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "inbound_message",
      waMessageId: "wamid.1",
      from: "15551234567",
      text: "hi",
      interactiveReplyId: null,
      phoneNumberId: "phone-1",
    });
  });

  it("parses an interactive button reply, surfacing both the title and the stable id", () => {
    const envelope: WebhookEnvelope = {
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-1" },
                messages: [
                  {
                    id: "wamid.2",
                    from: "15551234567",
                    timestamp: "1700000001",
                    type: "interactive",
                    interactive: { type: "button_reply", button_reply: { id: "opt_yes", title: "Yes please" } },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const [event] = parseWebhookEnvelope(envelope);
    expect(event).toMatchObject({ kind: "inbound_message", text: "Yes please", interactiveReplyId: "opt_yes" });
  });

  it("resolves a swipe-reply context id", () => {
    const envelope: WebhookEnvelope = {
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                messages: [
                  {
                    id: "wamid.3",
                    from: "15551234567",
                    timestamp: "1700000002",
                    type: "text",
                    text: { body: "replying" },
                    context: { id: "wamid.parent" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const [event] = parseWebhookEnvelope(envelope);
    expect(event).toMatchObject({ contextMessageId: "wamid.parent" });
  });
});

describe("parseWebhookEnvelope — status updates", () => {
  it.each(["sent", "delivered", "read"] as const)("parses a bare '%s' status with no classification", (status) => {
    const envelope = envelopeWithStatus({
      id: "wamid.10",
      status,
      timestamp: "1700000010",
      recipient_id: "15551234567",
    });
    const [event] = parseWebhookEnvelope(envelope);
    expect(event).toMatchObject({ kind: "status_update", status, classification: null, metaError: null });
  });

  it("classifies a failed status's errors[] entry", () => {
    const envelope = envelopeWithStatus({
      id: "wamid.11",
      status: "failed",
      timestamp: "1700000011",
      recipient_id: "15551234567",
      errors: [{ code: 131026, title: "Message undeliverable", message: "Message undeliverable" }],
    });
    const [event] = parseWebhookEnvelope(envelope);
    expect(event.kind).toBe("status_update");
    if (event.kind !== "status_update") throw new Error("unreachable");
    expect(event.classification?.disposition).toBe("PERMANENT_NUMBER");
    expect(event.metaError?.code).toBe(131026);
  });

  it("leaves classification null on a 'failed' status with no errors[] array", () => {
    const envelope = envelopeWithStatus({
      id: "wamid.12",
      status: "failed",
      timestamp: "1700000012",
      recipient_id: "15551234567",
    });
    const [event] = parseWebhookEnvelope(envelope);
    expect(event).toMatchObject({ classification: null, metaError: null });
  });

  it("drops a status with an unrecognised status value", () => {
    const envelope = envelopeWithStatus({
      id: "wamid.13",
      status: "some_future_status",
      timestamp: "1700000013",
      recipient_id: "15551234567",
    });
    expect(parseWebhookEnvelope(envelope)).toHaveLength(0);
  });

  it("returns an empty array for an envelope with no entries", () => {
    expect(parseWebhookEnvelope({})).toHaveLength(0);
  });
});

describe("THE integration point — webhook failures classify identically to send-response failures", () => {
  // META_ERROR_TAXONOMY.md §5/§6: a failure arriving via a webhook's
  // status.errors[] and a failure returned directly from a send call's
  // HTTP error response must classify IDENTICALLY, because both paths
  // funnel through the same classifyMetaFailure (see meta-error-mapping.ts).
  it.each([131026, 131049, 190, 130429, 999999] as const)(
    "code %s classifies the same whether it arrives via webhook errors[] or a send-response error body",
    (code) => {
      // Webhook path: domain/webhook-parser.ts's shape for one errors[] entry.
      const webhookEnvelope = envelopeWithStatus({
        id: "wamid.same",
        status: "failed",
        timestamp: "1700000099",
        recipient_id: "15551234567",
        errors: [{ code, title: "some title", message: "some message" }],
      });
      const [webhookEvent] = parseWebhookEnvelope(webhookEnvelope);
      if (webhookEvent.kind !== "status_update") throw new Error("unreachable");

      // Send-response path: infrastructure/meta-whatsapp-provider.ts's shape
      // for a non-2xx response body — same underlying `{ code, message }`,
      // parsed independently, run through the SAME function.
      const sendResponseClassification = classifyMetaFailure({ code, message: "some message" });

      expect(webhookEvent.classification).toEqual(sendResponseClassification);

      // And the provider's own bundling helper agrees too.
      const providerFailure = toProviderFailure({ code, message: "some message" });
      expect(webhookEvent.classification).toEqual(providerFailure.classification);
    },
  );
});
