/**
 * WhatsAppService — orchestrates sending over the `WhatsAppProvider` port
 * and processing inbound webhooks, without ever touching SQL directly (all
 * persistence goes through the `application/ports.ts` repository ports —
 * the architecture guard enforces this for every file under `modules/`).
 *
 * The one rule META_ERROR_TAXONOMY.md §4 calls "worth nothing if only
 * advisory": every send-path method consults `shouldBlockSend`
 * (suppression + consent, from `messaging-errors`) BEFORE calling the
 * provider — never after. See `guardAndSend` below.
 */
import { err, ok, type Result } from "@shared/result";
import { shouldBlockSend, type BlockReason } from "@modules/messaging-errors/domain/suppression";
import { computeWebhookEventId, shouldProcessWebhookEvent } from "../domain/webhook-idempotency";
import { parseWebhookEnvelope, type ParsedWebhookEvent, type WebhookEnvelope } from "../domain/webhook-parser";
import { mapMetaTemplate } from "../domain/template-mapper";
import type {
  CreateTemplateInput as ProviderCreateTemplateInput,
  DeleteTemplateInput as ProviderDeleteTemplateInput,
  DownloadMediaResult,
  InteractivePayload,
  MediaReference,
  MetaCredentials,
  MetaTemplateSendComponent,
  ProviderFailure,
  SendMessageResult,
  UpdateTemplateInput as ProviderUpdateTemplateInput,
  WhatsAppProvider,
} from "../domain/whatsapp-provider.interface";
import type {
  ContactStateRepositoryPort,
  MessageTemplateRepositoryPort,
  NewWhatsAppConfigInput,
  WebhookEventRepositoryPort,
  WhatsAppConfigRecord,
  WhatsAppConfigRepositoryPort,
  WhatsAppTemplateRecord,
} from "./ports";
import type { AccountId, ContactId } from "../../../packages/domain/src/ids";
import { tryParsePhoneNumber, type PhoneNumber } from "../../../packages/domain/src/phone-number";

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/** Why a send never reached the provider at all. */
export type SendFailure =
  | { readonly kind: "blocked"; readonly reason: BlockReason }
  | { readonly kind: "config_not_found"; readonly accountId: AccountId; readonly phoneNumberId: string }
  | { readonly kind: "provider_failure"; readonly failure: ProviderFailure };

export interface WhatsAppServiceDeps {
  readonly provider: WhatsAppProvider;
  readonly configs: WhatsAppConfigRepositoryPort;
  readonly templates: MessageTemplateRepositoryPort;
  readonly webhookEvents: WebhookEventRepositoryPort;
  readonly contactState: ContactStateRepositoryPort;
  /** Injectable clock for deterministic tests; defaults to `() => new Date()`. */
  readonly clock?: () => Date;
}

interface SendTextRequest {
  readonly accountId: AccountId;
  readonly contactId: ContactId;
  readonly phoneNumberId: string;
  readonly to: PhoneNumber;
  readonly text: string;
  readonly contextMessageId?: string;
}

interface SendTemplateRequest {
  readonly accountId: AccountId;
  readonly contactId: ContactId;
  readonly phoneNumberId: string;
  readonly to: PhoneNumber;
  readonly templateName: string;
  readonly languageCode: string;
  readonly components?: readonly MetaTemplateSendComponent[];
  readonly contextMessageId?: string;
}

interface SendInteractiveRequest {
  readonly accountId: AccountId;
  readonly contactId: ContactId;
  readonly phoneNumberId: string;
  readonly to: PhoneNumber;
  readonly interactive: InteractivePayload;
  readonly contextMessageId?: string;
}

interface SendMediaRequest {
  readonly accountId: AccountId;
  readonly contactId: ContactId;
  readonly phoneNumberId: string;
  readonly to: PhoneNumber;
  readonly kind: "image" | "video" | "document" | "audio";
  readonly media: MediaReference;
  readonly caption?: string;
  readonly filename?: string;
  readonly contextMessageId?: string;
}

export interface WebhookProcessingOutcome {
  readonly event: ParsedWebhookEvent;
  /** `true` when this event id had already been claimed by an earlier
   *  delivery — nothing was (re)classified, (re)suppressed, or (re)logged
   *  for it on this call. */
  readonly deduped: boolean;
}

export class WhatsAppService {
  private readonly provider: WhatsAppProvider;
  private readonly configs: WhatsAppConfigRepositoryPort;
  private readonly templates: MessageTemplateRepositoryPort;
  private readonly webhookEvents: WebhookEventRepositoryPort;
  private readonly contactState: ContactStateRepositoryPort;
  private readonly clock: () => Date;

  constructor(deps: WhatsAppServiceDeps) {
    this.provider = deps.provider;
    this.configs = deps.configs;
    this.templates = deps.templates;
    this.webhookEvents = deps.webhookEvents;
    this.contactState = deps.contactState;
    this.clock = deps.clock ?? (() => new Date());
  }

  // -------------------------------------------------------------------
  // Sending — every path funnels through guardAndSend.
  // -------------------------------------------------------------------

  async sendText(input: SendTextRequest): Promise<Result<SendMessageResult, SendFailure>> {
    return this.guardAndSend(input.accountId, input.contactId, input.to, input.phoneNumberId, (credentials) =>
      this.provider.sendText({
        ...credentials,
        to: input.to,
        text: input.text,
        contextMessageId: input.contextMessageId,
      }),
    );
  }

  async sendTemplate(input: SendTemplateRequest): Promise<Result<SendMessageResult, SendFailure>> {
    return this.guardAndSend(input.accountId, input.contactId, input.to, input.phoneNumberId, (credentials) =>
      this.provider.sendTemplate({
        ...credentials,
        to: input.to,
        templateName: input.templateName,
        languageCode: input.languageCode,
        components: input.components,
        contextMessageId: input.contextMessageId,
      }),
    );
  }

  async sendInteractive(input: SendInteractiveRequest): Promise<Result<SendMessageResult, SendFailure>> {
    return this.guardAndSend(input.accountId, input.contactId, input.to, input.phoneNumberId, (credentials) =>
      this.provider.sendInteractive({
        ...credentials,
        to: input.to,
        interactive: input.interactive,
        contextMessageId: input.contextMessageId,
      }),
    );
  }

  async sendMedia(input: SendMediaRequest): Promise<Result<SendMessageResult, SendFailure>> {
    return this.guardAndSend(input.accountId, input.contactId, input.to, input.phoneNumberId, (credentials) =>
      this.provider.sendMedia({
        ...credentials,
        to: input.to,
        kind: input.kind,
        media: input.media,
        caption: input.caption,
        filename: input.filename,
        contextMessageId: input.contextMessageId,
      }),
    );
  }

  /**
   * THE guard. Every `sendX` method above delegates here so the
   * suppression/consent check and the failure -> classification -> (maybe)
   * suppress pipeline can never be implemented twice, or forgotten by a
   * future new send method.
   *
   * Order matters (META_ERROR_TAXONOMY.md §3b/§4): consult suppression +
   * consent FIRST; only on a pass do we look up credentials and call the
   * provider at all. `shouldBlockSend` short-circuits before either
   * happens, so a blocked send never reaches the network.
   */
  private async guardAndSend(
    accountId: AccountId,
    contactId: ContactId,
    to: PhoneNumber,
    phoneNumberId: string,
    dispatch: (credentials: MetaCredentials) => Promise<Result<SendMessageResult, ProviderFailure>>,
  ): Promise<Result<SendMessageResult, SendFailure>> {
    const state = await this.contactState.findByPhoneNumber(accountId, to);
    const block = shouldBlockSend(
      state?.deliverabilityState ?? "unknown",
      state?.consentState ?? "unknown",
      state?.suppressedReasonCode ?? undefined,
    );
    if (block) {
      return err({ kind: "blocked", reason: block });
    }

    // ---------------------------------------------------------------
    // EXTENSION POINT — credit reservation.
    //
    // META_ERROR_TAXONOMY.md §3b/§4: "Opt-out check runs BEFORE credit
    // reservation" / "this check runs before the credit reservation, so a
    // suppressed number never consumes credits". The suppression/consent
    // guard above already satisfies that ordering requirement. A future
    // change adds a `CreditReservationPort` call RIGHT HERE — after the
    // guard above, before `configs.findByPhoneNumberId` below — that
    // fails closed (no reservation granted -> no send, no provider call).
    //
    // Do NOT implement credit/ledger/reservation/settlement logic in this
    // module: it is gated (see repo root `DO_NOT_BUILD_YET.md`) behind
    // hard gates this track does not clear. This comment is the only
    // acknowledgment of that future integration point.
    // ---------------------------------------------------------------

    const config = await this.configs.findByPhoneNumberId(accountId, phoneNumberId);
    if (!config) {
      return err({ kind: "config_not_found", accountId, phoneNumberId });
    }

    const result = await dispatch({ accessToken: config.accessToken, phoneNumberId: config.phoneNumberId });
    const now = this.clock().toISOString();

    if (!result.ok) {
      await this.contactState.recordDeliveryEvent({
        accountId,
        contactId,
        occurredAt: now,
        errorCode: result.error.classification.matchedKey,
        disposition: result.error.classification.disposition,
        rawError: result.error.metaError.raw ?? null,
        messageRef: null,
      });
      if (result.error.classification.disposition === "PERMANENT_NUMBER") {
        await this.contactState.applyPermanentNumberFailure(
          accountId,
          contactId,
          result.error.classification.matchedKey,
          now,
        );
      }
      return err({ kind: "provider_failure", failure: result.error });
    }

    return ok(result.value);
  }

  // -------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------

  async uploadMedia(
    accountId: AccountId,
    phoneNumberId: string,
    bytes: Uint8Array,
    mimeType: string,
    fileName?: string,
  ): Promise<Result<{ readonly mediaId: string }, SendFailure>> {
    const config = await this.requireConfig(accountId, phoneNumberId);
    if (!config.ok) return config;
    const result = await this.provider.uploadMedia({
      accessToken: config.value.accessToken,
      phoneNumberId: config.value.phoneNumberId,
      bytes,
      mimeType,
      fileName,
    });
    return result.ok ? ok(result.value) : err({ kind: "provider_failure", failure: result.error });
  }

  async downloadMedia(
    accountId: AccountId,
    phoneNumberId: string,
    mediaId: string,
  ): Promise<Result<DownloadMediaResult, SendFailure>> {
    const config = await this.requireConfig(accountId, phoneNumberId);
    if (!config.ok) return config;
    const result = await this.provider.downloadMedia({ accessToken: config.value.accessToken, mediaId });
    return result.ok ? ok(result.value) : err({ kind: "provider_failure", failure: result.error });
  }

  private async requireConfig(
    accountId: AccountId,
    phoneNumberId: string,
  ): Promise<Result<WhatsAppConfigRecord, SendFailure>> {
    const config = await this.configs.findByPhoneNumberId(accountId, phoneNumberId);
    if (!config) return err({ kind: "config_not_found", accountId, phoneNumberId });
    return ok(config);
  }

  /** Persists a freshly-registered / re-verified number's config row. */
  async saveConfig(input: NewWhatsAppConfigInput): Promise<WhatsAppConfigRecord> {
    return this.configs.upsert(input);
  }

  /**
   * Moves the account to a DIFFERENT number, retiring the one it had.
   *
   * Separate from `saveConfig` because the two are not interchangeable:
   * `upsert` is keyed on the phone number, so using it for a new number
   * leaves the old row in place and every send keeps using it. See the port's
   * `replaceForAccount` for the atomicity requirement.
   */
  async replaceConfig(input: NewWhatsAppConfigInput): Promise<WhatsAppConfigRecord> {
    return this.configs.replaceForAccount(input);
  }

  // -------------------------------------------------------------------
  // Template CRUD — provider call, then map + persist the local mirror.
  // -------------------------------------------------------------------

  async listTemplates(accountId: AccountId): Promise<readonly WhatsAppTemplateRecord[]> {
    return this.templates.listByAccount(accountId);
  }

  async syncTemplatesFromMeta(
    accountId: AccountId,
    phoneNumberId: string,
    wabaId: string,
  ): Promise<Result<readonly WhatsAppTemplateRecord[], SendFailure>> {
    const config = await this.requireConfig(accountId, phoneNumberId);
    if (!config.ok) return config;

    const result = await this.provider.getTemplates({ accessToken: config.value.accessToken, wabaId });
    if (!result.ok) return err({ kind: "provider_failure", failure: result.error });

    const saved: WhatsAppTemplateRecord[] = [];
    for (const remote of result.value) {
      const mapped = mapMetaTemplate(remote);
      saved.push(await this.templates.upsert({ accountId, ...mapped }));
    }
    return ok(saved);
  }

  async createTemplate(
    accountId: AccountId,
    phoneNumberId: string,
    input: ProviderCreateTemplateInput,
  ): Promise<Result<WhatsAppTemplateRecord, SendFailure>> {
    const config = await this.requireConfig(accountId, phoneNumberId);
    if (!config.ok) return config;

    const result = await this.provider.createTemplate({ ...input, accessToken: config.value.accessToken });
    if (!result.ok) return err({ kind: "provider_failure", failure: result.error });

    const mapped = mapMetaTemplate(result.value);
    return ok(await this.templates.upsert({ accountId, ...mapped }));
  }

  async updateTemplate(
    accountId: AccountId,
    phoneNumberId: string,
    input: ProviderUpdateTemplateInput,
  ): Promise<Result<void, SendFailure>> {
    const config = await this.requireConfig(accountId, phoneNumberId);
    if (!config.ok) return config;

    const result = await this.provider.updateTemplate({ ...input, accessToken: config.value.accessToken });
    if (!result.ok) return err({ kind: "provider_failure", failure: result.error });

    // Every edit re-triggers Meta review — the local mirror must reflect
    // that immediately rather than show a stale "approved" status.
    await this.templates.updateStatus(accountId, input.metaTemplateId, "pending", this.clock().toISOString());
    return ok(undefined);
  }

  async deleteTemplate(
    accountId: AccountId,
    phoneNumberId: string,
    input: ProviderDeleteTemplateInput,
  ): Promise<Result<void, SendFailure>> {
    const config = await this.requireConfig(accountId, phoneNumberId);
    if (!config.ok) return config;

    const result = await this.provider.deleteTemplate({ ...input, accessToken: config.value.accessToken });
    if (!result.ok) return err({ kind: "provider_failure", failure: result.error });

    await this.templates.delete(accountId, input.metaTemplateId ?? input.name);
    return ok(undefined);
  }

  // -------------------------------------------------------------------
  // Inbound webhooks — parse, dedupe, classify/suppress/log exactly once.
  // -------------------------------------------------------------------

  /**
   * Processes one webhook delivery's whole envelope. Idempotent per event:
   * a redelivered event is reported back with `deduped: true` and produces
   * no side effect (see `domain/webhook-idempotency.ts`).
   *
   * `status_update` events carrying a `classification` (i.e. `failed`
   * status with a recognised error) run through the exact same
   * record-delivery-event / maybe-suppress pipeline as `guardAndSend`'s
   * failure branch above — this is the §5 integration point: a webhook
   * failure and a send-response failure both end up calling
   * `contactState.applyPermanentNumberFailure` the same way, because both
   * were classified by the same `classifyMetaFailure`.
   */
  async processWebhookEvent(
    accountId: AccountId,
    envelope: WebhookEnvelope,
  ): Promise<readonly WebhookProcessingOutcome[]> {
    const events = parseWebhookEnvelope(envelope);
    const outcomes: WebhookProcessingOutcome[] = [];

    for (const event of events) {
      const eventId = computeWebhookEventId(event);
      const now = this.clock().toISOString();
      const claim = await this.webhookEvents.claim(accountId, eventId, event, now);

      if (!shouldProcessWebhookEvent(claim)) {
        outcomes.push({ event, deduped: true });
        continue;
      }

      if (event.kind === "status_update" && event.status === "failed" && event.classification) {
        const phone = tryParsePhoneNumber(event.recipientId);
        if (phone) {
          const state = await this.contactState.findByPhoneNumber(accountId, phone);
          if (state) {
            await this.contactState.recordDeliveryEvent({
              accountId,
              contactId: state.contactId,
              occurredAt: now,
              errorCode: event.classification.matchedKey,
              disposition: event.classification.disposition,
              rawError: event.metaError?.raw ?? null,
              messageRef: event.waMessageId,
            });
            if (event.classification.disposition === "PERMANENT_NUMBER") {
              await this.contactState.applyPermanentNumberFailure(
                accountId,
                state.contactId,
                event.classification.matchedKey,
                now,
              );
            }
          }
        }
      }

      outcomes.push({ event, deduped: false });
    }

    return outcomes;
  }
}
