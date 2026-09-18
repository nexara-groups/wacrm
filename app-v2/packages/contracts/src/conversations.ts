/**
 * Conversations — list with filters, get thread (paginated), assign, mark
 * read, unread totals, and the incremental-sync request/response (cursor
 * in, changes + next cursor out) that web/mobile clients poll.
 */
import { z } from "zod";
import {
  accountIdSchema,
  contactIdSchema,
  conversationIdSchema,
  isoDateTimeSchema,
  userIdSchema,
} from "./common/ids";
import { apiResult } from "./common/response";
import { paginatedResponseSchema, paginationQuerySchema } from "./common/pagination";
import { booleanQueryFlagSchema } from "./common/query-flag";
import { messageSchema } from "./messages";

// ---------------------------------------------------------------------------
// The Conversation resource
// ---------------------------------------------------------------------------

export const conversationStatusSchema = z.enum(["open", "closed"]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const conversationSchema = z.object({
  id: conversationIdSchema,
  accountId: accountIdSchema,
  contactId: contactIdSchema,
  assignedUserId: userIdSchema.nullable(),
  /**
   * open/closed. `ConversationRecord` has always carried this; the wire
   * shape did not, so a closed conversation was indistinguishable from an
   * open one and the inbox could neither show nor filter by it.
   */
  status: conversationStatusSchema,
  lastMessageAt: isoDateTimeSchema.nullable(),
  unreadCount: z.number().int().min(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Conversation = z.infer<typeof conversationSchema>;

// ---------------------------------------------------------------------------
// List — filterable
// ---------------------------------------------------------------------------

/**
 * "unassigned" is a real filter value, not a missing one.
 *
 * `ConversationFilter.assignedUserId` distinguishes three cases —
 * `undefined` (no filter), `null` (only unassigned), a UserId (only that
 * assignee). A bare `userIdSchema.optional()` could express only two of
 * them, so "show me what nobody has picked up" — the single most useful
 * view in a shared inbox — could not be requested at all, and the UI was
 * reduced to filtering one page in the browser.
 */
export const assignedUserFilterSchema = z.union([userIdSchema, z.literal("unassigned")]);
export type AssignedUserFilter = z.infer<typeof assignedUserFilterSchema>;

export const listConversationsQuerySchema = paginationQuerySchema.extend({
  assignedUserId: assignedUserFilterSchema.optional(),
  status: conversationStatusSchema.optional(),
  /** `true` = only conversations with `unreadCount > 0`; `false`/omitted = all.
   *  See `booleanQueryFlagSchema` for why this is not `z.coerce.boolean()`. */
  unreadOnly: booleanQueryFlagSchema.optional(),
  search: z.string().min(1).max(200).optional(),
});
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const listConversationsResponseSchema = apiResult(paginatedResponseSchema(conversationSchema).shape);
export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;

// ---------------------------------------------------------------------------
// Get thread — paginated messages within one conversation
// ---------------------------------------------------------------------------

export const getThreadQuerySchema = paginationQuerySchema.extend({
  conversationId: conversationIdSchema,
});
export type GetThreadQuery = z.infer<typeof getThreadQuerySchema>;

export const getThreadResponseSchema = apiResult({
  conversation: conversationSchema,
  ...paginatedResponseSchema(messageSchema).shape,
});
export type GetThreadResponse = z.infer<typeof getThreadResponseSchema>;

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------

export const assignConversationRequestSchema = z.object({
  conversationId: conversationIdSchema,
  /** `null` unassigns. */
  assignedUserId: userIdSchema.nullable(),
});
export type AssignConversationRequest = z.infer<typeof assignConversationRequestSchema>;

export const assignConversationResponseSchema = apiResult({ conversation: conversationSchema });
export type AssignConversationResponse = z.infer<typeof assignConversationResponseSchema>;

// ---------------------------------------------------------------------------
// Mark read
// ---------------------------------------------------------------------------

export const markConversationReadRequestSchema = z.object({ conversationId: conversationIdSchema });
export type MarkConversationReadRequest = z.infer<typeof markConversationReadRequestSchema>;

export const markConversationReadResponseSchema = apiResult({ conversation: conversationSchema });
export type MarkConversationReadResponse = z.infer<typeof markConversationReadResponseSchema>;

// ---------------------------------------------------------------------------
// Unread totals
// ---------------------------------------------------------------------------

export const conversationUnreadEntrySchema = z.object({
  conversationId: conversationIdSchema,
  unreadCount: z.number().int().min(1),
});
export type ConversationUnreadEntry = z.infer<typeof conversationUnreadEntrySchema>;

export const unreadTotalsResponseSchema = apiResult({
  totalUnread: z.number().int().min(0),
  byConversation: z.array(conversationUnreadEntrySchema),
});
export type UnreadTotalsResponse = z.infer<typeof unreadTotalsResponseSchema>;

// ---------------------------------------------------------------------------
// Incremental sync — cursor in, changes + next cursor out. `cursor: null`
// (or omitted) means "from the beginning" — a first sync / full resync.
// ---------------------------------------------------------------------------

export const syncConversationsRequestSchema = z.object({
  cursor: z.string().min(1).nullable().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type SyncConversationsRequest = z.infer<typeof syncConversationsRequestSchema>;

export const conversationSyncChangeSchema = z.discriminatedUnion("changeType", [
  z.object({ changeType: z.literal("upserted"), conversation: conversationSchema }),
  z.object({ changeType: z.literal("deleted"), conversationId: conversationIdSchema }),
]);
export type ConversationSyncChange = z.infer<typeof conversationSyncChangeSchema>;

export const syncConversationsResponseSchema = apiResult({
  changes: z.array(conversationSyncChangeSchema),
  /** Pass this back as `cursor` on the next call. `null` means "fully caught up". */
  nextCursor: z.string().min(1).nullable(),
  hasMore: z.boolean(),
});
export type SyncConversationsResponse = z.infer<typeof syncConversationsResponseSchema>;
