/**
 * Messages — send text, send template, send media, send interactive;
 * message status; reactions.
 */
import { z } from "zod";
import {
  accountIdSchema,
  contactIdSchema,
  conversationIdSchema,
  isoDateTimeSchema,
  messageIdSchema,
  templateIdSchema,
} from "./common/ids";
import { apiResult } from "./common/response";
import { messageDirectionSchema, messageTypeSchema, recipientStatusSchema } from "./common/vocab";

// ---------------------------------------------------------------------------
// The Message resource
// ---------------------------------------------------------------------------

export const messageSchema = z.object({
  id: messageIdSchema,
  accountId: accountIdSchema,
  conversationId: conversationIdSchema,
  contactId: contactIdSchema,
  direction: messageDirectionSchema,
  type: messageTypeSchema,
  body: z.string().nullable(),
  templateId: templateIdSchema.nullable(),
  /** Meta's WhatsApp message id (`wamid...`), once sent/received. */
  waMessageId: z.string().min(1).nullable(),
  status: recipientStatusSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Message = z.infer<typeof messageSchema>;

// ---------------------------------------------------------------------------
// Send text
// ---------------------------------------------------------------------------

export const sendTextMessageRequestSchema = z.object({
  conversationId: conversationIdSchema,
  body: z.string().min(1).max(4096),
});
export type SendTextMessageRequest = z.infer<typeof sendTextMessageRequestSchema>;

export const sendTextMessageResponseSchema = apiResult({ message: messageSchema });
export type SendTextMessageResponse = z.infer<typeof sendTextMessageResponseSchema>;

// ---------------------------------------------------------------------------
// Send template — META_ERROR_TAXONOMY.md §3 132000/132012: parameter COUNT
// and per-parameter FORMAT are both real Meta-side rejection modes, so the
// request carries parameters as an ordered list of plain strings (Meta
// hydrates `{{1}}`, `{{2}}`, ... positionally) rather than a free-form
// record, matching how `Template.variableCount` is validated against it.
// ---------------------------------------------------------------------------

export const sendTemplateMessageRequestSchema = z.object({
  conversationId: conversationIdSchema,
  templateId: templateIdSchema,
  /** BCP-47 / Meta locale code, e.g. "en_US", "hi" — mirrors `Template.language`. */
  languageCode: z.string().min(2).max(10),
  parameters: z.array(z.string().max(1000)).max(30).default([]),
});
export type SendTemplateMessageRequest = z.infer<typeof sendTemplateMessageRequestSchema>;

export const sendTemplateMessageResponseSchema = apiResult({ message: messageSchema });
export type SendTemplateMessageResponse = z.infer<typeof sendTemplateMessageResponseSchema>;

// ---------------------------------------------------------------------------
// Send media
// ---------------------------------------------------------------------------

export const mediaKindSchema = z.enum(["image", "video", "audio", "document", "sticker"]);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const sendMediaMessageRequestSchema = z.object({
  conversationId: conversationIdSchema,
  mediaKind: mediaKindSchema,
  /** Either a previously-uploaded Meta media id or a fetchable URL — exactly one is required. */
  mediaId: z.string().min(1).optional(),
  mediaUrl: z.url().optional(),
  caption: z.string().max(1024).optional(),
  /** Required for `document`; ignored otherwise. */
  fileName: z.string().min(1).max(255).optional(),
}).refine((value) => Boolean(value.mediaId) !== Boolean(value.mediaUrl), {
  message: "Exactly one of mediaId or mediaUrl is required",
  path: ["mediaId"],
});
export type SendMediaMessageRequest = z.infer<typeof sendMediaMessageRequestSchema>;

export const sendMediaMessageResponseSchema = apiResult({ message: messageSchema });
export type SendMediaMessageResponse = z.infer<typeof sendMediaMessageResponseSchema>;

// ---------------------------------------------------------------------------
// Send interactive — WhatsApp "button" (<=3 quick replies) or "list" reply
// messages. META_ERROR_TAXONOMY.md §3b's "Stop promotions" quick-reply is an
// instance of the `button` shape sent server-side on marketing templates.
// ---------------------------------------------------------------------------

export const interactiveButtonSchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(20),
});
export type InteractiveButton = z.infer<typeof interactiveButtonSchema>;

export const interactiveListRowSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(24),
  description: z.string().max(72).optional(),
});
export type InteractiveListRow = z.infer<typeof interactiveListRowSchema>;

export const interactiveListSectionSchema = z.object({
  title: z.string().min(1).max(24),
  rows: z.array(interactiveListRowSchema).min(1).max(10),
});
export type InteractiveListSection = z.infer<typeof interactiveListSectionSchema>;

export const interactivePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("button"), buttons: z.array(interactiveButtonSchema).min(1).max(3) }),
  z.object({
    kind: z.literal("list"),
    buttonLabel: z.string().min(1).max(20),
    sections: z.array(interactiveListSectionSchema).min(1).max(10),
  }),
]);
export type InteractivePayload = z.infer<typeof interactivePayloadSchema>;

export const sendInteractiveMessageRequestSchema = z.object({
  conversationId: conversationIdSchema,
  bodyText: z.string().min(1).max(1024),
  interactive: interactivePayloadSchema,
});
export type SendInteractiveMessageRequest = z.infer<typeof sendInteractiveMessageRequestSchema>;

export const sendInteractiveMessageResponseSchema = apiResult({ message: messageSchema });
export type SendInteractiveMessageResponse = z.infer<typeof sendInteractiveMessageResponseSchema>;

// ---------------------------------------------------------------------------
// Message status
// ---------------------------------------------------------------------------

export const getMessageStatusRequestSchema = z.object({ messageId: messageIdSchema });
export type GetMessageStatusRequest = z.infer<typeof getMessageStatusRequestSchema>;

export const messageStatusSchema = z.object({
  messageId: messageIdSchema,
  status: recipientStatusSchema,
  /** Present only when `status === "failed"` — reuses the shared error envelope's code, never a bare Meta string (META_ERROR_TAXONOMY.md §4b writing rules). */
  errorCode: z.string().min(1).nullable(),
  updatedAt: isoDateTimeSchema,
});
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const getMessageStatusResponseSchema = apiResult({ status: messageStatusSchema });
export type GetMessageStatusResponse = z.infer<typeof getMessageStatusResponseSchema>;

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export const reactionSchema = z.object({
  messageId: messageIdSchema,
  /** A single emoji grapheme, e.g. "👍" — WhatsApp reactions are one emoji per message per sender. */
  emoji: z.string().min(1).max(8),
  reactedAt: isoDateTimeSchema,
});
export type Reaction = z.infer<typeof reactionSchema>;

export const sendReactionRequestSchema = z.object({
  messageId: messageIdSchema,
  emoji: z.string().min(1).max(8),
});
export type SendReactionRequest = z.infer<typeof sendReactionRequestSchema>;

export const sendReactionResponseSchema = apiResult({ reaction: reactionSchema });
export type SendReactionResponse = z.infer<typeof sendReactionResponseSchema>;

/** An empty `emoji` removes the reaction — mirrors WhatsApp Cloud API's own reaction-removal convention (send a reaction message with `emoji: ""`). */
export const removeReactionRequestSchema = z.object({ messageId: messageIdSchema });
export type RemoveReactionRequest = z.infer<typeof removeReactionRequestSchema>;

export const removeReactionResponseSchema = apiResult({});
export type RemoveReactionResponse = z.infer<typeof removeReactionResponseSchema>;
