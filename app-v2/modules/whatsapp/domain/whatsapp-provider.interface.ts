/**
 * WhatsAppProvider — the vendor PORT. Interface only; no fetch, no vendor
 * SDK, no `@supabase/*` import. The ONE implementation that talks to the
 * network lives at `infrastructure/meta-whatsapp-provider.ts`
 * (META_ERROR_TAXONOMY.md §5's "WhatsAppProvider (MetaWhatsAppProvider)").
 *
 * Every method that can fail against the vendor returns a `Result` whose
 * error branch is a `ProviderFailure` — never a thrown raw Meta string.
 * `ProviderFailure` already carries the parsed `MetaError` AND its
 * `Classification` (§5: "MetaErrorClassifier ... fully unit-testable"), so
 * callers (application/whatsapp-service.ts) never re-derive classification
 * from a caught exception — the provider did it once, at the source.
 */
import type { Result } from "@shared/result";
import type { Classification, MetaError } from "@modules/messaging-errors/domain/meta-error-classifier";
import type { PhoneNumber } from "../../../packages/domain/src/phone-number";

/** A failed vendor call, already classified. See file header. */
export interface ProviderFailure {
  readonly metaError: MetaError;
  readonly classification: Classification;
}

export type ProviderResult<T> = Result<T, ProviderFailure>;

/** Credentials + routing every call needs. Stateless provider — the caller
 *  (application layer, via the config repository) supplies these per call
 *  rather than the provider holding a single tenant's token. */
export interface MetaCredentials {
  readonly accessToken: string;
  readonly phoneNumberId: string;
}

export interface SendTextInput extends MetaCredentials {
  readonly to: PhoneNumber;
  readonly text: string;
  /** Meta's `wamid...` of the message being replied to (quote preview). */
  readonly contextMessageId?: string;
}

export type MediaKind = "image" | "video" | "document" | "audio";

/** Media is referenced either by a public URL Meta fetches at send time,
 *  or by a Meta media id obtained from `uploadMedia`. */
export type MediaReference = { readonly link: string } | { readonly id: string };

export interface SendMediaInput extends MetaCredentials {
  readonly to: PhoneNumber;
  readonly kind: MediaKind;
  readonly media: MediaReference;
  /** Ignored by Meta for `kind: "audio"`. */
  readonly caption?: string;
  /** Document-only. */
  readonly filename?: string;
  readonly contextMessageId?: string;
}

/** One already-built `template.components[]` entry, Meta's send-time shape
 *  (header/body/button parameter arrays) — built upstream by the caller
 *  from the stored `message_templates.components` + the send-time values.
 *  Left as `unknown`-free but intentionally loose (`Record<string, unknown>`)
 *  because Meta's parameter shapes vary by component/button type and this
 *  port does not re-validate template structure; validation of what CAN be
 *  sent belongs to the template domain (out of scope here — see
 *  domain/template-mapper.ts for the read-back mapping direction). */
export interface MetaTemplateSendComponent {
  readonly type: "header" | "body" | "button";
  readonly [key: string]: unknown;
}

export interface SendTemplateInput extends MetaCredentials {
  readonly to: PhoneNumber;
  readonly templateName: string;
  /** Meta locale code, e.g. "en_US". */
  readonly languageCode: string;
  readonly components?: readonly MetaTemplateSendComponent[];
  readonly contextMessageId?: string;
}

export interface InteractiveButton {
  readonly id: string;
  readonly title: string;
}

export interface InteractiveListRow {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

export interface InteractiveListSection {
  readonly title?: string;
  readonly rows: readonly InteractiveListRow[];
}

export type InteractivePayload =
  | {
      readonly kind: "buttons";
      readonly bodyText: string;
      readonly headerText?: string;
      readonly footerText?: string;
      readonly buttons: readonly InteractiveButton[];
    }
  | {
      readonly kind: "list";
      readonly bodyText: string;
      readonly buttonLabel: string;
      readonly headerText?: string;
      readonly footerText?: string;
      readonly sections: readonly InteractiveListSection[];
    };

export interface SendInteractiveInput extends MetaCredentials {
  readonly to: PhoneNumber;
  readonly interactive: InteractivePayload;
  readonly contextMessageId?: string;
}

export interface SendMessageResult {
  /** Meta's `wamid...` for the message just sent. */
  readonly waMessageId: string;
}

export interface UploadMediaInput extends MetaCredentials {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly fileName?: string;
}

export interface UploadMediaResult {
  /** Meta media id — usable as a `MediaReference` (`{ id }`) on a later send. */
  readonly mediaId: string;
}

export interface DownloadMediaInput {
  readonly accessToken: string;
  readonly mediaId: string;
}

export interface DownloadMediaResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** Meta's Cloud API template category — see packages/domain Template entity
 *  for the mapped-down internal vocabulary; this is the vendor's own string. */
export type MetaTemplateCategoryRaw = "MARKETING" | "UTILITY" | "AUTHENTICATION" | string;
/** Meta's template review status — vendor's own string, mapped down by
 *  domain/template-mapper.ts. */
export type MetaTemplateStatusRaw =
  | "APPROVED"
  | "PENDING"
  | "REJECTED"
  | "PAUSED"
  | "DISABLED"
  | "IN_APPEAL"
  | string;

/** One `components[]` entry as Meta stores/returns it for a template
 *  definition (distinct from `MetaTemplateSendComponent`, which is the
 *  send-time, per-message parameter shape). */
export interface MetaTemplateDefinitionComponent {
  readonly type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS" | string;
  readonly format?: string;
  readonly text?: string;
  readonly buttons?: readonly Record<string, unknown>[];
  readonly example?: Record<string, unknown>;
}

/** A template as Meta's Business Management API returns it. */
export interface MetaTemplateRecord {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly category: MetaTemplateCategoryRaw;
  readonly status: MetaTemplateStatusRaw;
  readonly components: readonly MetaTemplateDefinitionComponent[];
}

export interface GetTemplatesInput {
  readonly accessToken: string;
  readonly wabaId: string;
}

export interface CreateTemplateInput {
  readonly accessToken: string;
  readonly wabaId: string;
  readonly name: string;
  readonly language: string;
  readonly category: MetaTemplateCategoryRaw;
  readonly components: readonly MetaTemplateDefinitionComponent[];
}

export interface UpdateTemplateInput {
  readonly accessToken: string;
  /** Meta's template id (stored as `message_templates.meta_template_id`). */
  readonly metaTemplateId: string;
  readonly components: readonly MetaTemplateDefinitionComponent[];
  readonly category?: MetaTemplateCategoryRaw;
}

export interface DeleteTemplateInput {
  readonly accessToken: string;
  readonly wabaId: string;
  readonly name: string;
  /** Without this, Meta deletes every language variant sharing `name`. */
  readonly metaTemplateId?: string;
}

/**
 * The WhatsApp Cloud API port. One implementation (`MetaWhatsAppProvider`)
 * exists today; the interface exists so `application/whatsapp-service.ts`
 * never imports `infrastructure/*` or `fetch` directly, and so tests can
 * supply an in-memory fake.
 */
export interface WhatsAppProvider {
  sendText(input: SendTextInput): Promise<ProviderResult<SendMessageResult>>;
  sendTemplate(input: SendTemplateInput): Promise<ProviderResult<SendMessageResult>>;
  sendInteractive(input: SendInteractiveInput): Promise<ProviderResult<SendMessageResult>>;
  sendMedia(input: SendMediaInput): Promise<ProviderResult<SendMessageResult>>;

  uploadMedia(input: UploadMediaInput): Promise<ProviderResult<UploadMediaResult>>;
  downloadMedia(input: DownloadMediaInput): Promise<ProviderResult<DownloadMediaResult>>;

  getTemplates(input: GetTemplatesInput): Promise<ProviderResult<readonly MetaTemplateRecord[]>>;
  createTemplate(input: CreateTemplateInput): Promise<ProviderResult<MetaTemplateRecord>>;
  updateTemplate(input: UpdateTemplateInput): Promise<ProviderResult<void>>;
  deleteTemplate(input: DeleteTemplateInput): Promise<ProviderResult<void>>;
}
