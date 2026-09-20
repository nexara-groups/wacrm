/**
 * MetaWhatsAppProvider — the ONE place a WhatsApp Cloud API vendor call
 * lives in this module (META_ERROR_TAXONOMY.md §5's "WhatsAppProvider
 * (MetaWhatsAppProvider)"). Every method talks to `fetch` directly; nothing
 * outside `infrastructure/` may.
 *
 * Every failure path — a non-2xx response, a network exception, an
 * unparseable body — is converted to a `ProviderFailure` via
 * `domain/meta-error-mapping.ts`'s `toProviderFailure`, which extracts
 * code/subcode/message/parameter and classifies through the SAME
 * `classifyMetaFailure` the webhook path uses. Nothing here ever throws a
 * raw Meta string upward; every method returns a `ProviderResult`.
 *
 * Shapes (endpoints, payload fields, error envelope) follow
 * `src/lib/whatsapp/meta-api.ts` (the app being replaced) — see this
 * module's SubagentHandback report for the specific assumptions made where
 * that reference was silent (resumable-upload vs `/media` upload choice,
 * template list pagination, parameter-name extraction).
 */
import { err, ok } from "@shared/result";
import { toProviderFailure, type RawMetaErrorPayload } from "../domain/meta-error-mapping";
import type {
  CreateTemplateInput,
  DeleteTemplateInput,
  DownloadMediaInput,
  DownloadMediaResult,
  GetTemplatesInput,
  MetaTemplateRecord,
  ProviderResult,
  SendInteractiveInput,
  SendMediaInput,
  SendMessageResult,
  SendTemplateInput,
  SendTextInput,
  UpdateTemplateInput,
  UploadMediaInput,
  UploadMediaResult,
  WhatsAppProvider,
} from "../domain/whatsapp-provider.interface";

export const META_API_VERSION = "v21.0";
export const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

interface MetaErrorEnvelope {
  readonly error?: {
    readonly message?: string;
    readonly code?: number;
    readonly error_subcode?: number;
    readonly type?: string;
    readonly error_data?: { readonly details?: string };
  };
}

async function parseErrorBody(response: Response): Promise<RawMetaErrorPayload> {
  try {
    const data = (await response.json()) as MetaErrorEnvelope;
    if (data.error) {
      return {
        code: data.error.code,
        error_subcode: data.error.error_subcode,
        message: data.error.message,
        type: data.error.type,
        error_data: data.error.error_data,
        httpStatus: response.status,
      };
    }
  } catch {
    // Body wasn't JSON (or wasn't Meta's envelope shape) — fall through to
    // the HTTP-status-only payload below.
  }
  return { httpStatus: response.status, message: `Meta API error: ${response.status}` };
}

function networkFailurePayload(error: unknown): RawMetaErrorPayload {
  return {
    isNetworkError: true,
    message: error instanceof Error ? error.message : String(error),
  };
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly name = "meta-whatsapp-cloud-api";

  private async request<T>(
    url: string,
    init: RequestInit,
    parseSuccess: (response: Response) => Promise<T>,
  ): Promise<ProviderResult<T>> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      return err(toProviderFailure(networkFailurePayload(error)));
    }

    if (!response.ok) {
      return err(toProviderFailure(await parseErrorBody(response)));
    }

    try {
      return ok(await parseSuccess(response));
    } catch (error) {
      return err(
        toProviderFailure({
          httpStatus: response.status,
          message: `Meta returned an unparseable success response: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      );
    }
  }

  private postMessage(
    phoneNumberId: string,
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<ProviderResult<SendMessageResult>> {
    return this.request(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
      },
      async (response) => {
        const data = (await response.json()) as { messages?: readonly { id: string }[] };
        const waMessageId = data.messages?.[0]?.id;
        if (!waMessageId) throw new Error("Meta accepted the send but returned no message id");
        return { waMessageId };
      },
    );
  }

  async sendText(input: SendTextInput): Promise<ProviderResult<SendMessageResult>> {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "text",
      text: { body: input.text },
    };
    if (input.contextMessageId) body.context = { message_id: input.contextMessageId };
    return this.postMessage(input.phoneNumberId, input.accessToken, body);
  }

  async sendTemplate(input: SendTemplateInput): Promise<ProviderResult<SendMessageResult>> {
    const template: Record<string, unknown> = {
      name: input.templateName,
      language: { code: input.languageCode },
    };
    if (input.components && input.components.length > 0) template.components = input.components;

    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "template",
      template,
    };
    if (input.contextMessageId) body.context = { message_id: input.contextMessageId };
    return this.postMessage(input.phoneNumberId, input.accessToken, body);
  }

  async sendInteractive(input: SendInteractiveInput): Promise<ProviderResult<SendMessageResult>> {
    const payload = input.interactive;
    const interactive: Record<string, unknown> =
      payload.kind === "buttons"
        ? {
            type: "button",
            body: { text: payload.bodyText },
            action: {
              buttons: payload.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
            },
          }
        : {
            type: "list",
            body: { text: payload.bodyText },
            action: {
              button: payload.buttonLabel,
              sections: payload.sections.map((s) => ({
                ...(s.title ? { title: s.title } : {}),
                rows: s.rows.map((r) => ({
                  id: r.id,
                  title: r.title,
                  ...(r.description ? { description: r.description } : {}),
                })),
              })),
            },
          };
    if (payload.headerText) interactive.header = { type: "text", text: payload.headerText };
    if (payload.footerText) interactive.footer = { text: payload.footerText };

    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "interactive",
      interactive,
    };
    if (input.contextMessageId) body.context = { message_id: input.contextMessageId };
    return this.postMessage(input.phoneNumberId, input.accessToken, body);
  }

  async sendMedia(input: SendMediaInput): Promise<ProviderResult<SendMessageResult>> {
    const media: Record<string, unknown> = { ...input.media };
    if (input.caption && input.kind !== "audio") media.caption = input.caption;
    if (input.kind === "document" && input.filename) media.filename = input.filename;

    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: input.kind,
      [input.kind]: media,
    };
    if (input.contextMessageId) body.context = { message_id: input.contextMessageId };
    return this.postMessage(input.phoneNumberId, input.accessToken, body);
  }

  /**
   * Uses the standard `/{phone_number_id}/media` multipart upload (a
   * message attachment), not the app-scoped two-step Resumable Upload API
   * `src/lib/whatsapp/meta-api.ts` uses for TEMPLATE HEADER handles —
   * those are different Meta features keyed differently (phone number vs
   * app id) and this port's `uploadMedia` is documented (see
   * `whatsapp-provider.interface.ts`) as producing a `MediaReference`
   * usable on a later *message* send, which is what `/media` returns.
   */
  async uploadMedia(input: UploadMediaInput): Promise<ProviderResult<UploadMediaResult>> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", input.mimeType);
    const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mimeType });
    form.append("file", blob, input.fileName ?? "upload");

    return this.request(
      `${META_API_BASE}/${input.phoneNumberId}/media`,
      { method: "POST", headers: { Authorization: `Bearer ${input.accessToken}` }, body: form },
      async (response) => {
        const data = (await response.json()) as { id?: string };
        if (!data.id) throw new Error("Meta accepted the media upload but returned no media id");
        return { mediaId: data.id };
      },
    );
  }

  /** Two Meta calls under one port method: resolve the media id to a
   *  short-lived authenticated CDN URL, then fetch the bytes from it. */
  async downloadMedia(input: DownloadMediaInput): Promise<ProviderResult<DownloadMediaResult>> {
    const urlLookup = await this.request<{ url: string; mimeType: string }>(
      `${META_API_BASE}/${input.mediaId}`,
      { headers: { Authorization: `Bearer ${input.accessToken}` } },
      async (response) => {
        const data = (await response.json()) as { url?: string; mime_type?: string };
        if (!data.url) throw new Error("Meta media lookup returned no URL");
        return { url: data.url, mimeType: data.mime_type ?? "application/octet-stream" };
      },
    );
    if (!urlLookup.ok) return urlLookup;

    return this.request(
      urlLookup.value.url,
      { headers: { Authorization: `Bearer ${input.accessToken}` } },
      async (response) => {
        const contentType = response.headers.get("content-type") ?? urlLookup.value.mimeType;
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { bytes, contentType };
      },
    );
  }

  // -------------------------------------------------------------------
  // Template CRUD (Business Management API)
  // -------------------------------------------------------------------

  /**
   * Fetches only the first page. Meta paginates `message_templates` via
   * `paging.next`; following it is left for a future change (the read
   * model here is "list what's approved to reconcile status", not a bulk
   * export, and accounts realistically hold far fewer than one page's
   * worth of templates) — documented as an assumption in the
   * SubagentHandback report, not silently dropped.
   */
  async getTemplates(input: GetTemplatesInput): Promise<ProviderResult<readonly MetaTemplateRecord[]>> {
    const url = `${META_API_BASE}/${input.wabaId}/message_templates?fields=id,name,language,category,status,components`;
    return this.request(
      url,
      { headers: { Authorization: `Bearer ${input.accessToken}` } },
      async (response) => {
        const data = (await response.json()) as { data?: readonly MetaTemplateRecord[] };
        return data.data ?? [];
      },
    );
  }

  async createTemplate(input: CreateTemplateInput): Promise<ProviderResult<MetaTemplateRecord>> {
    const url = `${META_API_BASE}/${input.wabaId}/message_templates`;
    return this.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.accessToken}` },
        body: JSON.stringify({
          name: input.name,
          language: input.language,
          category: input.category,
          components: input.components,
        }),
      },
      async (response) => {
        const data = (await response.json()) as { id?: string; status?: string; category?: string };
        if (!data.id) throw new Error("Meta accepted the template but returned no id");
        return {
          id: data.id,
          name: input.name,
          language: input.language,
          category: data.category ?? input.category,
          status: data.status ?? "PENDING",
          components: input.components,
        };
      },
    );
  }

  /** Meta REPLACES the components array on edit; it does not patch. */
  async updateTemplate(input: UpdateTemplateInput): Promise<ProviderResult<void>> {
    const body: Record<string, unknown> = { components: input.components };
    if (input.category) body.category = input.category;
    return this.request(
      `${META_API_BASE}/${input.metaTemplateId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.accessToken}` },
        body: JSON.stringify(body),
      },
      async () => undefined,
    );
  }

  /** Without `metaTemplateId` (Meta's `hsm_id` param), Meta deletes every
   *  language variant sharing `name` — matches the reference behaviour. A
   *  404 is treated as an already-deleted no-op, not a failure. */
  async deleteTemplate(input: DeleteTemplateInput): Promise<ProviderResult<void>> {
    const params = new URLSearchParams({ name: input.name });
    if (input.metaTemplateId) params.set("hsm_id", input.metaTemplateId);
    const url = `${META_API_BASE}/${input.wabaId}/message_templates?${params.toString()}`;

    let response: Response;
    try {
      response = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${input.accessToken}` } });
    } catch (error) {
      return err(toProviderFailure(networkFailurePayload(error)));
    }
    if (response.status === 404) return ok(undefined);
    if (!response.ok) return err(toProviderFailure(await parseErrorBody(response)));
    return ok(undefined);
  }
}
