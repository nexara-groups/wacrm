/**
 * Demo data for the conversations/inbox slice.
 *
 * Everything below goes through the real `ConversationRepository`/
 * `MessageRepository` (`ctx.repositories.conversations` /
 * `ctx.repositories.messages`), never a raw insert — a message is recorded
 * via `insert()` and then the conversation's unread/last-message counters
 * are advanced with the SAME pure domain functions
 * (`recordInboundMessage`/`recordOutboundMessage`/`markRead`/
 * `assignConversation`/`closeConversation`, `@modules/conversations/domain/
 * conversation`) a real route would use, followed by `save()`. Outbound
 * message delivery status is advanced the same way, through the pure
 * `applyMessageStatusUpdate` state machine (`@modules/conversations/domain/
 * message`) plus `save()` — never a status column written directly.
 *
 * Four conversations, built to exercise the inbox screen honestly rather
 * than just render a happy path:
 *   A — unassigned, open, one unread inbound message (unread badge, no
 *       assignee chip).
 *   B — assigned to the demo owner, mixes a fully-read outbound
 *       (sent -> delivered -> read) with a SECOND outbound that fails
 *       (sent -> failed), so failure rendering is real, not theoretical.
 *   C — closed (via `closeConversation`), read. Exercises the domain's
 *       open/closed lifecycle even though — see `lib/conversation-dto.ts`'s
 *       header — the wire `Conversation` has no `status` field to show it
 *       through, a contract gap this seeder cannot fix.
 *   D — a 25-message thread, long enough that `GET .../messages`'s default
 *       page size actually needs a second page, ending on an unread inbound
 *       message so the total-unread badge has more than one contributor.
 */
import { randomUUID } from "node:crypto";
import { ConversationId, MessageId, UserId, type RecipientStatus } from "@packages/domain";
import {
  assignConversation,
  closeConversation,
  markRead,
  recordInboundMessage,
  recordOutboundMessage,
  type ConversationRecord,
} from "@modules/conversations/domain/conversation";
import {
  applyMessageStatusUpdate,
  timestampFieldForStatus,
  type MessageRecord,
} from "@modules/conversations/domain/message";
import type { SeedContext } from "./types";

function minutesAgo(now: string, minutes: number): string {
  return new Date(new Date(now).getTime() - minutes * 60_000).toISOString();
}

async function addInbound(
  ctx: SeedContext,
  conversation: ConversationRecord,
  body: string,
  occurredAt: string,
): Promise<ConversationRecord> {
  await ctx.repositories.messages.insert(ctx.tenant, {
    id: MessageId(randomUUID()),
    conversationId: conversation.id,
    contactId: conversation.contactId,
    direction: "inbound",
    type: "text",
    body,
    templateId: null,
    waMessageId: null,
    replyToId: null,
    mediaRef: null,
    // Inbound messages are always "delivered" in practice — see
    // `packages/domain/src/entities/message.ts`'s `status` docstring.
    status: "delivered",
    occurredAt,
  });
  const next = recordInboundMessage(conversation, occurredAt);
  return ctx.repositories.conversations.save(ctx.tenant, next);
}

/** Advances one outbound message through the real, pure status machine, one legal hop at a time. */
async function advanceMessageStatus(
  ctx: SeedContext,
  message: MessageRecord,
  to: RecipientStatus,
  at: string,
): Promise<MessageRecord> {
  const result = applyMessageStatusUpdate(message.status, to);
  if (!result.ok) {
    throw new Error(
      `seed: illegal message status transition ${message.status} -> ${to}: ${result.error.message}`,
    );
  }
  const field = timestampFieldForStatus(result.value);
  const next: MessageRecord = {
    ...message,
    status: result.value,
    updatedAt: at,
    ...(field ? { [field]: at } : {}),
  };
  return ctx.repositories.messages.save(ctx.tenant, next);
}

async function addOutbound(
  ctx: SeedContext,
  conversation: ConversationRecord,
  body: string,
  occurredAt: string,
  statusPath: readonly RecipientStatus[],
): Promise<ConversationRecord> {
  let message = await ctx.repositories.messages.insert(ctx.tenant, {
    id: MessageId(randomUUID()),
    conversationId: conversation.id,
    contactId: conversation.contactId,
    direction: "outbound",
    type: "text",
    body,
    templateId: null,
    waMessageId: null,
    replyToId: null,
    mediaRef: null,
    status: "pending",
    occurredAt,
  });
  for (const status of statusPath) {
    message = await advanceMessageStatus(ctx, message, status, occurredAt);
  }
  const next = recordOutboundMessage(conversation, occurredAt);
  return ctx.repositories.conversations.save(ctx.tenant, next);
}

export async function seedConversations(ctx: SeedContext): Promise<void> {
  const { items: contacts } = await ctx.repositories.contacts.search(ctx.tenant, {}, {
    page: 1,
    pageSize: 50,
  });
  if (contacts.length === 0) return;
  const pick = (i: number) => contacts[i % contacts.length]!;

  // --- Conversation A: unassigned, unread inbound -------------------------
  const convAContact = pick(0);
  let convA = await ctx.repositories.conversations.create(ctx.tenant, {
    id: ConversationId(randomUUID()),
    contactId: convAContact.id,
    now: ctx.now,
  });
  convA = await addInbound(ctx, convA, "Hi, is my order shipped yet?", minutesAgo(ctx.now, 5));

  // --- Conversation B: assigned, one delivered+read reply, one FAILED send
  const convBContact = pick(1);
  let convB = await ctx.repositories.conversations.create(ctx.tenant, {
    id: ConversationId(randomUUID()),
    contactId: convBContact.id,
    now: ctx.now,
  });
  convB = await addInbound(ctx, convB, "Do you have this in blue?", minutesAgo(ctx.now, 120));
  convB = await addOutbound(
    ctx,
    convB,
    "Yes! Let me check stock for you.",
    minutesAgo(ctx.now, 115),
    ["sent", "delivered", "read"],
  );
  convB = await ctx.repositories.conversations.save(ctx.tenant, markRead(convB));
  convB = await addOutbound(
    ctx,
    convB,
    "Reminder: your cart is waiting for checkout.",
    minutesAgo(ctx.now, 60),
    ["sent", "failed"],
  );
  convB = await ctx.repositories.conversations.save(
    ctx.tenant,
    assignConversation(convB, UserId(ctx.ownerUserId)),
  );

  // --- Conversation C: closed, read -----------------------------------------
  const convCContact = pick(2);
  let convC = await ctx.repositories.conversations.create(ctx.tenant, {
    id: ConversationId(randomUUID()),
    contactId: convCContact.id,
    now: ctx.now,
  });
  convC = await addInbound(ctx, convC, "Never mind, found it.", minutesAgo(ctx.now, 300));
  convC = await ctx.repositories.conversations.save(ctx.tenant, markRead(convC));
  convC = await ctx.repositories.conversations.save(ctx.tenant, closeConversation(convC));

  // --- Conversation D: a long thread, ending unread, to exercise pagination
  const convDContact = pick(3);
  let convD = await ctx.repositories.conversations.create(ctx.tenant, {
    id: ConversationId(randomUUID()),
    contactId: convDContact.id,
    now: ctx.now,
  });
  const THREAD_LENGTH = 25;
  const BASE_MINUTES_AGO = 500;
  for (let i = 0; i < THREAD_LENGTH; i += 1) {
    const occurredAt = minutesAgo(ctx.now, BASE_MINUTES_AGO - i * 4);
    if (i % 2 === 0) {
      convD = await addInbound(ctx, convD, `Customer note #${i + 1} in a long thread.`, occurredAt);
    } else {
      convD = await addOutbound(ctx, convD, `Agent reply #${i + 1}.`, occurredAt, [
        "sent",
        "delivered",
      ]);
    }
  }
  // Deliberately no `markRead(convD)` — the thread ends on an inbound
  // message (i = 24 is even), so it stays unread on purpose.
}
