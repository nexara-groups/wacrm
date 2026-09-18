/**
 * Conversations — list with filters, get thread (paginated), assign, mark
 * read, unread totals, and the incremental-sync cursor endpoint web/mobile
 * poll.
 */
import type {
  AssignConversationRequest,
  AssignConversationResponse,
  GetThreadQuery,
  GetThreadResponse,
  ListConversationsQuery,
  ListConversationsResponse,
  MarkConversationReadRequest,
  MarkConversationReadResponse,
  SyncConversationsRequest,
  SyncConversationsResponse,
  UnreadTotalsResponse,
} from "@packages/contracts/src/index";
import {
  assignConversationResponseSchema,
  getThreadResponseSchema,
  listConversationsResponseSchema,
  markConversationReadResponseSchema,
  syncConversationsResponseSchema,
  unreadTotalsResponseSchema,
} from "@packages/contracts/src/index";
import { apiRequest, type ApiClientContext, type SuccessOf } from "../http";
import type { ApiClientError } from "../errors";
import type { Result } from "../result";

export interface ConversationsResource {
  list(
    query?: ListConversationsQuery,
  ): Promise<Result<SuccessOf<ListConversationsResponse>, ApiClientError>>;
  thread(query: GetThreadQuery): Promise<Result<SuccessOf<GetThreadResponse>, ApiClientError>>;
  assign(
    request: AssignConversationRequest,
  ): Promise<Result<SuccessOf<AssignConversationResponse>, ApiClientError>>;
  markRead(
    request: MarkConversationReadRequest,
  ): Promise<Result<SuccessOf<MarkConversationReadResponse>, ApiClientError>>;
  /** No request schema exists for this endpoint (see `packages/contracts/src/conversations.ts`) — the account is resolved from the caller's auth context server-side, same as the *response* schema's absence of an `accountId` echo. */
  unreadTotals(): Promise<Result<SuccessOf<UnreadTotalsResponse>, ApiClientError>>;
  sync(
    request: SyncConversationsRequest,
  ): Promise<Result<SuccessOf<SyncConversationsResponse>, ApiClientError>>;
}

export function createConversationsResource(ctx: ApiClientContext): ConversationsResource {
  return {
    list: (query) =>
      apiRequest(ctx, { method: "GET", path: "/conversations.list", query }, listConversationsResponseSchema),

    thread: (query) =>
      apiRequest(ctx, { method: "GET", path: "/conversations.thread", query }, getThreadResponseSchema),

    assign: (request) =>
      apiRequest(ctx, { method: "POST", path: "/conversations.assign", body: request }, assignConversationResponseSchema),

    markRead: (request) =>
      apiRequest(
        ctx,
        { method: "POST", path: "/conversations.markRead", body: request },
        markConversationReadResponseSchema,
      ),

    unreadTotals: () =>
      apiRequest(ctx, { method: "GET", path: "/conversations.unreadTotals" }, unreadTotalsResponseSchema),

    sync: (request) =>
      apiRequest(ctx, { method: "POST", path: "/conversations.sync", body: request }, syncConversationsResponseSchema),
  };
}
