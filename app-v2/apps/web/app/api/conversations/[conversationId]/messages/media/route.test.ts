import { describe, expect, it, vi, beforeEach } from "vitest";

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

const sendMediaMock = vi.fn(async (_req: any): Promise<any> => ({ ok: true, value: { waMessageId: "wamid.123" } }));

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
  getWhatsAppContainer: async () => ({ service: { sendMedia: sendMediaMock } }),
}));

const { POST } = await import("./route");

function post(body: unknown): Request {
  return new Request(`https://example.test/api/conversations/${CONVERSATION_ID}/messages/media`, {
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
  sendMediaMock.mockClear();
  sendMediaMock.mockImplementation(async () => ({ ok: true, value: { waMessageId: "wamid.123" } }));
  repositories.messages.insert.mockClear();
});

describe("POST /api/conversations/[conversationId]/messages/media", () => {
  it("happy path (mediaId): 201, persists caption/mediaRef, and dispatches an id reference", async () => {
    const res = await POST(
      post({ mediaKind: "image", mediaId: "media-abc", caption: "Look at this" }) as never,
      ctx() as never,
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.message.type).toBe("media");
    expect(json.message.body).toBe("Look at this");

    expect(insertedMessages).toHaveLength(1);
    expect(insertedMessages[0].type).toBe("media");
    expect(insertedMessages[0].body).toBe("Look at this");
    expect(insertedMessages[0].templateId).toBeNull();
    expect(insertedMessages[0].mediaRef).toBe("media-abc");

    expect(sendMediaMock).toHaveBeenCalledTimes(1);
    expect(sendMediaMock.mock.calls[0]![0].media).toEqual({ id: "media-abc" });
  });

  it("happy path (mediaUrl, document with fileName): persists mediaUrl as mediaRef", async () => {
    const res = await POST(
      post({ mediaKind: "document", mediaUrl: "https://example.test/f.pdf", fileName: "invoice.pdf" }) as never,
      ctx() as never,
    );
    expect(res.status).toBe(201);
    expect(insertedMessages[0].mediaRef).toBe("https://example.test/f.pdf");
    expect(insertedMessages[0].body).toBeNull();
    expect(sendMediaMock.mock.calls[0]![0].media).toEqual({ link: "https://example.test/f.pdf" });
  });

  it("a blocked SendFailure returns 409 and persists nothing", async () => {
    sendMediaMock.mockImplementation(async () => ({
      ok: false,
      error: { kind: "blocked", reason: { kind: "opted_out" } },
    }));
    const res = await POST(post({ mediaKind: "image", mediaId: "media-abc" }) as never, ctx() as never);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("blocked_opted_out");
    expect(insertedMessages).toHaveLength(0);
    expect(repositories.messages.insert).not.toHaveBeenCalled();
  });

  it("returns 422 unsupported_media_kind for a sticker", async () => {
    const res = await POST(post({ mediaKind: "sticker", mediaId: "media-abc" }) as never, ctx() as never);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("unsupported_media_kind");
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("returns 422 filename_required for a document with no fileName", async () => {
    const res = await POST(
      post({ mediaKind: "document", mediaUrl: "https://example.test/f.pdf" }) as never,
      ctx() as never,
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("filename_required");
    expect(sendMediaMock).not.toHaveBeenCalled();
  });
});
