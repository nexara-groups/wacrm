import { describe, expect, it, vi, beforeEach } from "vitest";
import { MAX_UPLOAD_BYTES } from "@/lib/media-upload";

const TENANT_ID = "11111111-1111-1111-8111-111111111111";
const NOW = "2026-01-01T00:00:00.000Z";

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

let configs: any[] = [makeConfig()];

const uploadMediaMock = vi.fn(async (..._args: any[]): Promise<any> => ({
  ok: true,
  value: { mediaId: "media-xyz" },
}));

const repositories = {
  whatsappConfig: {
    listByAccount: vi.fn(async () => configs),
  },
};

vi.mock("@/lib/container", () => ({
  getContainer: async () => ({ repositories, tenant: { tenantId: TENANT_ID } }),
}));
vi.mock("@/lib/whatsapp-container", () => ({
  getWhatsAppContainer: async () => ({ service: { uploadMedia: uploadMediaMock } }),
}));

const { POST } = await import("./route");

function postFormData(form: FormData, extraHeaders?: Record<string, string>): Request {
  const body = form;
  const req = new Request("https://example.test/api/media", {
    method: "POST",
    body,
  });
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      req.headers.set(key, value);
    }
  }
  return req;
}

/** A `Request` whose `content-length` header lies about the real body size. */
function postWithFakeContentLength(form: FormData, claimedLength: number): Request {
  const req = postFormData(form);
  // `Request` derives its own content-length from the actual body; override
  // the getter to simulate a client that lies about it, exercising the
  // route's check #1 (header) independently of check #2 (parsed size).
  (req.headers as unknown as Record<string, unknown>).get = (name: string) =>
    name.toLowerCase() === "content-length" ? String(claimedLength) : null;
  return req;
}

beforeEach(() => {
  configs = [makeConfig()];
  uploadMediaMock.mockClear();
  uploadMediaMock.mockImplementation(async () => ({ ok: true, value: { mediaId: "media-xyz" } }));
  repositories.whatsappConfig.listByAccount.mockClear();
});

describe("POST /api/media", () => {
  it("happy path: uploads within the allow-list and returns a mediaId", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }));

    const res = await POST(postFormData(form) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.mediaId).toBe("media-xyz");

    expect(uploadMediaMock).toHaveBeenCalledTimes(1);
    const [accountId, phoneNumberId, bytes, mimeType, fileName] = uploadMediaMock.mock.calls[0]!;
    expect(accountId).toBe(TENANT_ID);
    expect(phoneNumberId).toBe("phone-123");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(3);
    expect(mimeType).toBe("image/jpeg");
    expect(fileName).toBe("photo.jpg");
  });

  it("rejects an over-cap upload by content-length before reading the body", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(10)], "small.jpg", { type: "image/jpeg" }));

    const req = postWithFakeContentLength(form, MAX_UPLOAD_BYTES + 1);
    const res = await POST(req as never);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error.code).toBe("payload_too_large");
    expect(json.error.laymanMessage).toMatch(/5 MB/);
    // Never even reached the container / provider.
    expect(uploadMediaMock).not.toHaveBeenCalled();
  });

  it("rejects an over-cap upload by actual bytes when content-length lies", async () => {
    const bigBytes = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    const form = new FormData();
    form.set("file", new File([bigBytes], "big.jpg", { type: "image/jpeg" }));

    // Real `content-length` on this Request will reflect the true (large)
    // multipart body, i.e. NOT a lie for check #1 — this exercises check #2
    // (actual parsed `file.size`), which is what must catch a genuinely
    // lying header in production.
    const res = await POST(postFormData(form) as never);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error.code).toBe("payload_too_large");
    expect(uploadMediaMock).not.toHaveBeenCalled();
  });

  it("returns 422 unsupported_media_type for a MIME type outside the allow-list", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "archive.zip", { type: "application/zip" }));

    const res = await POST(postFormData(form) as never);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("unsupported_media_type");
    expect(uploadMediaMock).not.toHaveBeenCalled();
  });

  it("returns 400 missing_file when the file field is absent", async () => {
    const form = new FormData();
    form.set("notfile", "hello");

    const res = await POST(postFormData(form) as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("missing_file");
    expect(uploadMediaMock).not.toHaveBeenCalled();
  });

  it("maps a provider upload failure through sendFailureResponse", async () => {
    uploadMediaMock.mockImplementation(async () => ({
      ok: false,
      error: { kind: "provider_failure", failure: { metaError: { message: "Meta: rate limited" } } },
    }));
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }));

    const res = await POST(postFormData(form) as never);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe("provider_failure");
  });

  it("returns config_not_found's mapped response when no WhatsApp config exists", async () => {
    configs = [];
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }));

    const res = await POST(postFormData(form) as never);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe("whatsapp_not_configured");
    expect(uploadMediaMock).not.toHaveBeenCalled();
  });
});
