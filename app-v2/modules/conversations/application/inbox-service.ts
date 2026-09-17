/**
 * InboxService — message ingestion (inbound webhooks + outbound sends),
 * thread pagination, reactions, and the incremental-sync endpoint that
 * replaces the 6 Supabase `postgres_changes` channels (SUPABASE_EXIT_PLAN.md
 * §1 — message thread, inbox, presence, total-unread, notifications page,
 * notification count all collapse into "what changed since my cursor?").
 *
 * Never touches SQL — delegates to `ConversationRepository` /
 * `MessageRepository`, and computes every state change via the pure
 * `domain/conversation.ts` / `domain/message.ts` / `domain/incremental-
 * sync.ts` functions first.
 */
import { AppError } from "@shared/errors";
import { err, ok, type Result } from "@shared/result";
import type { TenantContext } from "@nexara/core/context";
import type { ContactId, ConversationId, MessageId, RecipientStatus } from "@packages/domain";
import {
  recordInboundMessage,
  recordOutboundMessage,
  type ConversationRecord,
} from "../domain/conversation";
import { applyMessageStatusUpdate, timestampFieldForStatus, type MessageRecord } from "../domain/message";
import {
  advanceSyncCursor,
  type SequenceCursor,
  type SyncCursor,
} from "../domain/incremental-sync";
import type {
  ConversationRepository,
  MessageRepository,
  NewMessageInput,
  ThreadPage,
} from "./ports";

export interface InboxServiceDeps {
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  /** Injectable clock for deterministic tests; defaults to `() => new Date().toISOString()`. */
  readonly clock?: () => string;
  /** Injectable id generator for new conversations/messages; defaults to `crypto.randomUUID()`. */
  readonly newId?: () => string;
}

/** Bounds every thread fetch — this module's contract is "never load an entire conversation." */
const MAX_THREAD_PAGE_SIZE = 100;
const DEFAULT_THREAD_PAGE_SIZE = 50;

/** Bounds every sync page for the same reason. */
const MAX_SYNC_PAGE_SIZE = 200;
const DEFAULT_SYNC_PAGE_SIZE = 100;

export interface SyncResult {
  readonly conversations: readonly ConversationRecord[];
  readonly messages: readonly MessageRecord[];
  readonly conversationsCursor: SyncCursor;
  readonly messagesCursor: SyncCursor;
}

export class InboxService {
  private readonly conversations: ConversationRepository;
  private readonly messages: MessageRepository;
  private readonly clock: () => string;
  private readonly newId: () => string;

  constructor(deps: InboxServiceDeps) {
    this.conversations = deps.conversations;
    this.messages = deps.messages;
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Records a new INBOUND message (from a Meta webhook): finds-or-creates the
   * contact's conversation, inserts the message, and applies
   * `recordInboundMessage` to the conversation (bumps unread, advances
   * `lastMessageAt`/`lastInboundAt`, reopens if closed) — all via the pure
   * domain functions, persisted through the repositories.
   *
   * Idempotent: if `input.waMessageId` names a message already stored for
   * this tenant (Meta redelivery), the existing message is returned and the
   * conversation counters are NOT touched a second time.
   */
  async recordInbound(
    tenant: TenantContext,
    contactId: ContactId,
    input: Omit<NewMessageInput, "conversationId" | "contactId" | "direction" | "id"> & { readonly id?: MessageId },
  ): Promise<Result<{ conversation: ConversationRecord; message: MessageRecord }, AppError>> {
    if (input.waMessageId) {
      const existing = await this.messages.findByWaMessageId(tenant, input.waMessageId);
      if (existing) {
        const conversation = await this.conversations.findById(tenant, existing.conversationId);
        if (!conversation) return err(AppError.database("message exists but its conversation does not"));
        return ok({ conversation, message: existing });
      }
    }

    let conversation = await this.conversations.findByContactId(tenant, contactId);
    if (!conversation) {
      conversation = await this.conversations.create(tenant, {
        id: this.newId() as ConversationId,
        contactId,
        now: this.clock(),
      });
    }

    const message = await this.messages.insert(tenant, {
      id: (input.id ?? this.newId()) as MessageId,
      conversationId: conversation.id,
      contactId,
      direction: "inbound",
      type: input.type,
      body: input.body,
      templateId: input.templateId,
      waMessageId: input.waMessageId,
      replyToId: input.replyToId,
      mediaRef: input.mediaRef,
      status: input.status,
      occurredAt: input.occurredAt,
    });

    const nextConversation = recordInboundMessage(conversation, input.occurredAt);
    const saved = await this.conversations.save(tenant, nextConversation);
    return ok({ conversation: saved, message });
  }

  /**
   * Records a new OUTBOUND message (the inbox operator sending, or the
   * `whatsapp` module after a successful Meta send). Advances
   * `lastMessageAt` only — never touches `unreadCount`/`lastInboundAt`
   * (invariant #2, `domain/conversation.ts`).
   */
  async recordOutbound(
    tenant: TenantContext,
    conversationId: ConversationId,
    input: Omit<NewMessageInput, "conversationId" | "direction" | "id"> & { readonly id?: MessageId },
  ): Promise<Result<{ conversation: ConversationRecord; message: MessageRecord }, AppError>> {
    const conversation = await this.conversations.findById(tenant, conversationId);
    if (!conversation) return err(AppError.notFound("Conversation not found"));

    const message = await this.messages.insert(tenant, {
      id: (input.id ?? this.newId()) as MessageId,
      conversationId,
      contactId: input.contactId,
      direction: "outbound",
      type: input.type,
      body: input.body,
      templateId: input.templateId,
      waMessageId: input.waMessageId,
      replyToId: input.replyToId,
      mediaRef: input.mediaRef,
      status: input.status,
      occurredAt: input.occurredAt,
    });

    const nextConversation = recordOutboundMessage(conversation, input.occurredAt);
    const saved = await this.conversations.save(tenant, nextConversation);
    return ok({ conversation: saved, message });
  }

  /**
   * Applies a Meta delivery-receipt webhook to a message's status, via the
   * MONOTONIC `applyMessageStatusUpdate` machine (`domain/message.ts`) — safe
   * against out-of-order webhook arrival. `errorCode` is stamped only when
   * the resolved status is `failed`.
   */
  async applyStatusWebhook(
    tenant: TenantContext,
    waMessageId: string,
    incomingStatus: RecipientStatus,
    at: string,
    errorCode?: string,
  ): Promise<Result<MessageRecord, AppError>> {
    const message = await this.messages.findByWaMessageId(tenant, waMessageId);
    if (!message) return err(AppError.notFound(`No message found for wamid ${waMessageId}`));

    const transition = applyMessageStatusUpdate(message.status, incomingStatus);
    if (!transition.ok) return err(transition.error);
    if (transition.value === message.status) return ok(message); // stale/duplicate webhook — no-op

    const timestampField = timestampFieldForStatus(transition.value);
    const next: MessageRecord = {
      ...message,
      status: transition.value,
      errorCode: transition.value === "failed" ? (errorCode ?? message.errorCode) : message.errorCode,
      ...(timestampField ? { [timestampField]: at } : {}),
      updatedAt: at,
    };
    return ok(await this.messages.save(tenant, next));
  }

  /**
   * Thread page for a conversation, newest-first, bounded and keyset-
   * paginated — this NEVER loads a whole conversation. `opts.before` fetches
   * strictly older messages than the given cursor.
   */
  async getThread(
    tenant: TenantContext,
    conversationId: ConversationId,
    opts: { readonly limit?: number; readonly before?: SequenceCursor } = {},
  ): Promise<ThreadPage> {
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_THREAD_PAGE_SIZE), MAX_THREAD_PAGE_SIZE);
    return this.messages.listThread(tenant, conversationId, { limit, before: opts.before });
  }

  /**
   * Incremental-sync read: everything changed since `conversationsCursor` /
   * `messagesCursor`, bounded per call. Callers (the polling client) keep
   * calling with the returned cursors — see `domain/incremental-sync.ts` for
   * why this cannot skip a concurrently-committed change.
   */
  async syncSince(
    tenant: TenantContext,
    conversationsCursor: SyncCursor,
    messagesCursor: SyncCursor,
    limit = DEFAULT_SYNC_PAGE_SIZE,
  ): Promise<SyncResult> {
    const boundedLimit = Math.min(Math.max(1, limit), MAX_SYNC_PAGE_SIZE);
    const [conversationsPage, messagesPage] = await Promise.all([
      this.conversations.listChangedSince(tenant, conversationsCursor, boundedLimit),
      this.messages.listChangedSince(tenant, messagesCursor, boundedLimit),
    ]);
    return {
      conversations: conversationsPage.items,
      messages: messagesPage.items,
      conversationsCursor: advanceSyncCursor(conversationsCursor, conversationsPage.items),
      messagesCursor: advanceSyncCursor(messagesCursor, messagesPage.items),
    };
  }

  async setReaction(
    tenant: TenantContext,
    input: {
      readonly messageId: MessageId;
      readonly actorType: "user" | "contact";
      readonly actorId: string;
      readonly emoji: string;
    },
  ): Promise<Result<void, AppError>> {
    const message = await this.messages.findById(tenant, input.messageId);
    if (!message) return err(AppError.notFound("Message not found"));
    await this.messages.setReaction(tenant, {
      id: this.newId(),
      messageId: input.messageId,
      actorType: input.actorType,
      actorId: input.actorId,
      emoji: input.emoji,
      now: this.clock(),
    });
    return ok(undefined);
  }
}
