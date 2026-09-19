/**
 * Parses Meta's inbound webhook envelope into a flat list of typed events:
 * inbound messages, and status updates (sent/delivered/read/failed). A
 * `failed` status's `errors[]` is run through `classifyMetaFailure` — the
 * SAME function `infrastructure/meta-whatsapp-provider.ts` calls for a
 * send-response failure (see `meta-error-mapping.ts`'s file header) — so a
 * failure classifies identically no matter which path delivered it
 * (META_ERROR_TAXONOMY.md §5, §6 "Webhook-delivered failure suppresses
 * identically to send-response failure").
 *
 * Pure, vendor-free: takes already-parsed JSON, returns plain data. No
 * fetch, no DB, no signature verification (that is an HTTP-boundary
 * concern for the route/handler that owns the raw request, outside this
 * module's scope).
 */
import type { Classification, MetaError } from "@modules/messaging-errors/domain/meta-error-classifier";
import { classifyMetaFailure, toMetaError, type RawMetaErrorPayload } from "./meta-error-mapping";

// ---------------------------------------------------------------------------
// Meta's raw envelope shape (input)
// ---------------------------------------------------------------------------

export interface WebhookInboundMessage {
  readonly id: string;
  readonly from: string;
  readonly timestamp: string;
  readonly type: string;
  readonly text?: { readonly body: string };
  readonly image?: { readonly id: string; readonly mime_type: string; readonly caption?: string };
  readonly video?: { readonly id: string; readonly mime_type: string; readonly caption?: string };
  readonly document?: {
    readonly id: string;
    readonly mime_type: string;
    readonly filename?: string;
    readonly caption?: string;
  };
  readonly audio?: { readonly id: string; readonly mime_type: string };
  readonly sticker?: { readonly id: string; readonly mime_type: string };
  readonly location?: {
    readonly latitude: number;
    readonly longitude: number;
    readonly name?: string;
    readonly address?: string;
  };
  readonly interactive?: {
    readonly type: "button_reply" | "list_reply";
    readonly button_reply?: { readonly id: string; readonly title: string };
    readonly list_reply?: { readonly id: string; readonly title: string; readonly description?: string };
  };
  readonly context?: { readonly id: string };
}

export interface WebhookStatusErrorRaw {
  readonly code?: number;
  readonly title?: string;
  readonly message?: string;
  readonly error_subcode?: number;
  readonly error_data?: { readonly details?: string };
}

export type WebhookStatusValue = "sent" | "delivered" | "read" | "failed";

export interface WebhookStatus {
  readonly id: string;
  readonly status: WebhookStatusValue | string;
  readonly timestamp: string;
  readonly recipient_id: string;
  /** Present on `status === "failed"` — the whole point of this module's
   *  integration with `messaging-errors`. */
  readonly errors?: readonly WebhookStatusErrorRaw[];
}

export interface WebhookChangeValue {
  readonly messaging_product?: string;
  readonly metadata?: { readonly display_phone_number?: string; readonly phone_number_id?: string };
  readonly contacts?: readonly { readonly profile?: { readonly name?: string }; readonly wa_id?: string }[];
  readonly messages?: readonly WebhookInboundMessage[];
  readonly statuses?: readonly WebhookStatus[];
}

export interface WebhookChange {
  readonly field: string;
  readonly value: WebhookChangeValue;
}

export interface WebhookEntry {
  readonly id: string;
  readonly changes: readonly WebhookChange[];
}

/** The top-level POST body Meta sends. */
export interface WebhookEnvelope {
  readonly object?: string;
  readonly entry?: readonly WebhookEntry[];
}

// ---------------------------------------------------------------------------
// Parsed output (what the rest of the module consumes)
// ---------------------------------------------------------------------------

export interface ParsedInboundMessageEvent {
  readonly kind: "inbound_message";
  readonly phoneNumberId: string | null;
  readonly waMessageId: string;
  readonly from: string;
  readonly timestamp: string;
  readonly messageType: string;
  /** Best-effort plain text: message body, caption, interactive reply
   *  title, or a location summary — `null` when the type carries none. */
  readonly text: string | null;
  readonly interactiveReplyId: string | null;
  readonly contextMessageId: string | null;
  readonly raw: WebhookInboundMessage;
}

export interface ParsedStatusUpdateEvent {
  readonly kind: "status_update";
  readonly phoneNumberId: string | null;
  readonly waMessageId: string;
  readonly status: WebhookStatusValue;
  readonly recipientId: string;
  readonly timestamp: string;
  /** Non-null exactly when `status === "failed"` and Meta included at
   *  least one entry in `errors[]`. Built by the SAME `classifyMetaFailure`
   *  the send path uses — see this file's header. */
  readonly classification: Classification | null;
  readonly metaError: MetaError | null;
}

export type ParsedWebhookEvent = ParsedInboundMessageEvent | ParsedStatusUpdateEvent;

const KNOWN_STATUS_VALUES: ReadonlySet<string> = new Set(["sent", "delivered", "read", "failed"]);

function isKnownStatus(status: string): status is WebhookStatusValue {
  return KNOWN_STATUS_VALUES.has(status);
}

function parseInboundMessage(
  message: WebhookInboundMessage,
  phoneNumberId: string | null,
): ParsedInboundMessageEvent {
  let text: string | null = null;
  let interactiveReplyId: string | null = null;

  switch (message.type) {
    case "text":
      text = message.text?.body ?? null;
      break;
    case "image":
      text = message.image?.caption ?? null;
      break;
    case "video":
      text = message.video?.caption ?? null;
      break;
    case "document":
      text = message.document?.caption ?? message.document?.filename ?? null;
      break;
    case "location": {
      const loc = message.location;
      if (loc) {
        text = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`].filter(Boolean).join(" - ");
      }
      break;
    }
    case "interactive": {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
      if (reply) {
        text = reply.title || reply.id;
        interactiveReplyId = reply.id;
      }
      break;
    }
    default:
      text = null;
  }

  return {
    kind: "inbound_message",
    phoneNumberId,
    waMessageId: message.id,
    from: message.from,
    timestamp: message.timestamp,
    messageType: message.type,
    text,
    interactiveReplyId,
    contextMessageId: message.context?.id ?? null,
    raw: message,
  };
}

function toRawErrorPayload(error: WebhookStatusErrorRaw): RawMetaErrorPayload {
  return {
    code: error.code,
    error_subcode: error.error_subcode,
    message: error.message,
    title: error.title,
    error_data: error.error_data,
  };
}

function parseStatus(status: WebhookStatus, phoneNumberId: string | null): ParsedStatusUpdateEvent | null {
  if (!isKnownStatus(status.status)) return null;

  let classification: Classification | null = null;
  let metaError: MetaError | null = null;

  if (status.status === "failed" && status.errors && status.errors.length > 0) {
    // Meta's `failed` status envelope carries one logical error per
    // delivery attempt in practice; classify the first (matches how a
    // send-response failure — always a single error object — is
    // classified) so both paths agree on "one failure -> one
    // classification". See meta-error-mapping.ts's header comment.
    const firstError = status.errors[0];
    if (firstError) {
      const payload = toRawErrorPayload(firstError);
      metaError = toMetaError(payload);
      classification = classifyMetaFailure(payload);
    }
  }

  return {
    kind: "status_update",
    phoneNumberId,
    waMessageId: status.id,
    status: status.status,
    recipientId: status.recipient_id,
    timestamp: status.timestamp,
    classification,
    metaError,
  };
}

/**
 * Flattens the whole envelope (which may batch multiple entries/changes)
 * into one array of parsed events, in delivery order. Unknown message
 * types and unrecognised status values are not dropped for messages
 * (returned with `messageType`/`text` best-effort) but unrecognised status
 * values ARE dropped — there is nothing safe to classify or store for a
 * status value outside Meta's documented set.
 */
export function parseWebhookEnvelope(envelope: WebhookEnvelope): readonly ParsedWebhookEvent[] {
  const events: ParsedWebhookEvent[] = [];

  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes) {
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id ?? null;

      for (const message of value.messages ?? []) {
        events.push(parseInboundMessage(message, phoneNumberId));
      }
      for (const status of value.statuses ?? []) {
        const parsed = parseStatus(status, phoneNumberId);
        if (parsed) events.push(parsed);
      }
    }
  }

  return events;
}
