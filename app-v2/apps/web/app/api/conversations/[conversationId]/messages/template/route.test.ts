import { describe, expect, it, vi, beforeEach } from "vitest";

const TENANT_ID = "11111111-1111-1111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-2222-8222-222222222222";
const CONTACT_ID = "33333333-3333-3333-8333-333333333333";
const TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";
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

function makeTemplate(overrides: Record<string, unknown> = {}): any {
  return {
    id: TEMPLATE_ID,
    accountId: TENANT_ID,
    name: "order_update",
    language: "en_US",
    category: "utility",
    status: "approved",
    bodyText: "Hi {{1}}, your order {{2}} shipped.",
    variableCount: 2,
    metaTemplateId: "meta-1",
    components: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

let conversation: any = makeConversation();
let contact: any = makeContact();
let configs: any[] = [makeConfig()];
let template: any = makeTemplate();
let insertedMessages: any[] = [];

const sendTemplateMock = vi.fn(async (_req: any): Promise<any> => ({ ok: true, value: { waMessageId: "wamid.123" } }));

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
  messageTemplates: {
    findById: vi.fn(async () => template),
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
  getWhatsAppContainer: async () => ({ service: { sendTemplate: sendTemplateMock } }),
}));

// `messages:send`'s minimum role is "member", the lowest rank in the
// system — every real tenant role clears it, so there is no in-tenant role
// to prove a 403 against here. The gate is still real: an unauthenticated
// caller is what `authorizeAction` refuses.
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
  return new Request(`https://example.test/api/conversations/${CONVERSATION_ID}/messages/template`, {
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
  template = makeTemplate();
  insertedMessages = [];
  sessionUser = { userId: "u1", tenantId: TENANT_ID, role: "member" };
  sendTemplateMock.mockClear();
  sendTemplateMock.mockImplementation(async () => ({ ok: true, value: { waMessageId: "wamid.123" } }));
  repositories.messageTemplates.findById.mockClear();
  repositories.messages.insert.mockClear();
});

describe("POST /api/conversations/[conversationId]/messages/template", () => {
  it("happy path: 201, persists a rendered template row, and sends the right components", async () => {
    const res = await POST(
      post({ templateId: TEMPLATE_ID, languageCode: "en_US", parameters: ["Amy", "#42"] }) as never,
      ctx() as never,
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.message.type).toBe("template");
    expect(json.message.templateId).toBe(TEMPLATE_ID);

    expect(insertedMessages).toHaveLength(1);
    expect(insertedMessages[0].type).toBe("template");
    expect(insertedMessages[0].body).toBe("Hi Amy, your order #42 shipped.");
    expect(insertedMessages[0].templateId).toBe(TEMPLATE_ID);
    expect(insertedMessages[0].mediaRef).toBeNull();

    expect(sendTemplateMock).toHaveBeenCalledTimes(1);
    const call = sendTemplateMock.mock.calls[0]![0];
    expect(call.templateName).toBe("order_update");
    expect(call.languageCode).toBe("en_US");
    expect(call.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Amy" }, { type: "text", text: "#42" }] },
    ]);
  });

  it("zero parameters produces undefined components, never an empty body component", async () => {
    template = makeTemplate({ variableCount: 0, bodyText: "Thanks for your order." });
    const res = await POST(
      post({ templateId: TEMPLATE_ID, languageCode: "en_US", parameters: [] }) as never,
      ctx() as never,
    );
    expect(res.status).toBe(201);
    const call = sendTemplateMock.mock.calls[0]![0];
    expect(call.components).toBeUndefined();
  });

  it("a blocked SendFailure returns 409 and persists nothing", async () => {
    sendTemplateMock.mockImplementation(async () => ({
      ok: false,
      error: { kind: "blocked", reason: { kind: "opted_out" } },
    }));
    const res = await POST(
      post({ templateId: TEMPLATE_ID, languageCode: "en_US", parameters: ["Amy", "#42"] }) as never,
      ctx() as never,
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("blocked_opted_out");
    expect(insertedMessages).toHaveLength(0);
    expect(repositories.messages.insert).not.toHaveBeenCalled();
  });

  it("returns 404 template_not_found when the template doesn't exist", async () => {
    template = null;
    const res = await POST(
      post({ templateId: TEMPLATE_ID, languageCode: "en_US", parameters: ["Amy", "#42"] }) as never,
      ctx() as never,
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("not_found");
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });

  it("returns 409 template_not_approved for a non-approved template", async () => {
    template = makeTemplate({ status: "pending" });
    const res = await POST(
      post({ templateId: TEMPLATE_ID, languageCode: "en_US", parameters: ["Amy", "#42"] }) as never,
      ctx() as never,
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("template_not_approved");
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });

  it("returns 422 template_language_mismatch when languageCode differs from the stored template", async () => {
    const res = await POST(
      post({ templateId: TEMPLATE_ID, languageCode: "hi", parameters: ["Amy", "#42"] }) as never,
      ctx() as never,
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("template_language_mismatch");
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });

  it("returns 422 template_parameter_count when the parameter count doesn't match", async () => {
    const res = await POST(
      post({ templateId: TEMPLATE_ID, languageCode: "en_US", parameters: ["Amy"] }) as never,
      ctx() as never,
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("template_parameter_count");
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller before touching the conversation", async () => {
    sessionUser = null;
    const res = await POST(
      post({ templateId: TEMPLATE_ID, languageCode: "en_US", parameters: ["Amy", "#42"] }) as never,
      ctx() as never,
    );
    expect(res.status).toBe(401);
    expect(repositories.conversations.findById).not.toHaveBeenCalled();
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });
});
