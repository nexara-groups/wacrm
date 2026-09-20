import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * This route was refactored to build on `@/lib/send-plumbing` instead of
 * inlining the conversation/contact/config lookup and the SendFailure ->
 * HTTP mapping. Every case here existed (informally) before the refactor —
 * this file's job is to prove none of the status codes or bodies moved.
 */

const TENANT_ID = "11111111-1111-1111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-8222-222222222222";
const CONTACT_ID = "33333333-3333-3333-8333-333333333333";
const NOW = "2026-01-01T00:00:00.000Z";

function makeConversation(): any {
  return {
    id: CONVERSATION_ID,
    accountId: TENANT_ID,
    contactId: CONTACT_ID,
    assignedUserId: null,
    lastMessageAt: null,
    unreadCount: 0,
    status: "open",
    lastInboundAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeContact(): any {
  return {
    id: CONTACT_ID,
    accountId: TENANT_ID,
    phoneNumber: "+15551234567",
    displayName: "Test Contact",
    email: null,
    consentState: "unknown",
    optedOutAt: null,
    optOutSource: null,
    optOutEvidence: null,
    optOutScope: "all",
    deliverabilityState: "unknown",
    suppressedAt: null,
    suppressedReasonCode: null,
    suppressionStrikes: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeConfig(): any {
  return {
    id: "config-1",
    accountId: TENANT_ID,
    phoneNumberId: "phone-123",
    wabaId: "waba-1",
    displayName: null,
    qualityRating: null,
    verifiedName: null,
    registrationState: "registered",
    accessToken: "token",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

let conversation: any = makeConversation();
let contact: any = makeContact();
let configs: any[] = [makeConfig()];
let insertedMessages: any[] = [];

const sendTextMock = vi.fn(async (): Promise<any> => ({ ok: true, value: { waMessageId: "wamid.123" } }));

const repositories = {
  conversations: {
    findById: vi.fn(async () => conversation),
    save: vi.fn(async (_tenant: unknown, next: any) => next),
  },
  contacts: {
    findById: vi.fn(async () => contact),
  },
  whatsappConfig: {
    listByAccount: vi.fn(async () => configs),
  },
  messages: {
    insert: vi.fn(async (_tenant: unknown, input: any) => {
      const message = {
        ...input,
        accountId: TENANT_ID,
        createdAt: input.occurredAt,
        updatedAt: input.occurredAt,
        errorCode: null,
        sentAt: null,
        deliveredAt: null,
        readAt: null,
      };
      insertedMessages.push(message);
      return message;
    }),
  },
};

vi.mock("@/lib/container", () => ({
  getContainer: async () => ({ repositories, tenant: { tenantId: TENANT_ID } }),
}));
vi.mock("@/lib/whatsapp-container", () => ({
  getWhatsAppContainer: async () => ({ service: { sendText: sendTextMock } }),
}));

// `messages:send`'s minimum role is "member" (ACTION_MINIMUM_ROLE), the
// lowest rank in the system — every real tenant role clears it, so there is
// no in-tenant role to prove a 403 against here. The gate is still real: an
// unauthenticated caller is what `authorizeAction` refuses.
let sessionUser: { userId: string; tenantId: string; role: string } | null = {
  userId: "u1",
  tenantId: TENANT_ID,
  role: "member",
};
vi.mock("@/lib/session", () => ({
  getCurrentAuth: async () =>
    sessionUser ? { user: sessionUser, tenant: { tenantId: TENANT_ID }, accessToken: "t" } : null,
}));

const { POST } = await import("./route");

function post(body: unknown): Request {
  return new Request(`https://example.test/api/conversations/${CONVERSATION_ID}/messages/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx() {
  return { params: Promise.resolve({ conversationId: CONVERSATION_ID }) };
}

beforeEach(() => {
  conversation = makeConversation();
  contact = makeContact();
  configs = [makeConfig()];
  insertedMessages = [];
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "member" };
  sendTextMock.mockClear();
  sendTextMock.mockImplementation(async () => ({ ok: true, value: { waMessageId: "wamid.123" } }));
  repositories.conversations.findById.mockClear();
  repositories.contacts.findById.mockClear();
  repositories.whatsappConfig.listByAccount.mockClear();
  repositories.messages.insert.mockClear();
});

describe("POST /api/conversations/[conversationId]/messages/send", () => {
  it("happy path: 201 with the persisted text message", async () => {
    const res = await POST(post({ body: "Hello there" }) as never, ctx() as never);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.message.type).toBe("text");
    expect(json.message.body).toBe("Hello there");
    expect(json.message.templateId).toBeNull();
    expect(insertedMessages).toHaveLength(1);
    expect(insertedMessages[0].mediaRef).toBeNull();
  });

  it("a blocked SendFailure returns 409 and persists nothing", async () => {
    sendTextMock.mockImplementation(async () => ({ ok: false, error: { kind: "blocked", reason: { kind: "opted_out" } } }));
    const res = await POST(post({ body: "Hello there" }) as never, ctx() as never);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("blocked_opted_out");
    expect(insertedMessages).toHaveLength(0);
    expect(repositories.messages.insert).not.toHaveBeenCalled();
  });

  it("a provider_failure returns 502", async () => {
    sendTextMock.mockImplementation(async () => ({
      ok: false,
      error: { kind: "provider_failure", failure: { metaError: { message: "vendor down" } } },
    }));
    const res = await POST(post({ body: "Hello there" }) as never, ctx() as never);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe("provider_failure");
    expect(insertedMessages).toHaveLength(0);
  });

  it("returns 409 whatsapp_not_configured when no config exists", async () => {
    configs = [];
    const res = await POST(post({ body: "Hello there" }) as never, ctx() as never);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("whatsapp_not_configured");
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation doesn't exist", async () => {
    conversation = null;
    const res = await POST(post({ body: "Hello there" }) as never, ctx() as never);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("not_found");
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the contact doesn't exist", async () => {
    contact = null;
    const res = await POST(post({ body: "Hello there" }) as never, ctx() as never);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("not_found");
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller before touching the conversation", async () => {
    sessionUser = null;
    const res = await POST(post({ body: "Hello there" }) as never, ctx() as never);
    expect(res.status).toBe(401);
    expect(repositories.conversations.findById).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
  });
});
