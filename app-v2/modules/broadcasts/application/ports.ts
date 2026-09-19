/**
 * Broadcasts module — application-layer PORTS. Interfaces only: no SQL, no
 * vendor imports, no `core/database` import — mirrors
 * modules/organizations/application/ports.ts and
 * modules/identity/application/ports.ts's pattern. Persistence for the
 * tables this module owns (`broadcasts`, `broadcast_recipients` — see
 * db/migrations/{d1,postgres}/0009_broadcasts.sql) is implemented against
 * these shapes in `infrastructure/broadcast-repository.ts`.
 *
 * `AudienceSource`, `ContactStatePort` and `ContactSuppressionPort` read
 * from / write to the `contacts` table, which THIS module does not own or
 * migrate (see db/migrations/{d1,postgres}/0005_contact_deliverability.sql,
 * owned by the messaging-errors track) — declared here only as the shapes
 * this module depends on, exactly like `SeatRepository` declares shapes
 * owned elsewhere. Same for `MessageDispatchPort` (the WhatsApp send call)
 * and `OperatorAlertPort` (account-owner notifications).
 */
import type { AccountId, BroadcastId, ContactId, TemplateId, UserId } from "@packages/domain/src/ids";
import type { Broadcast } from "@packages/domain/src/entities/broadcast";
import type { BroadcastRecipient } from "@packages/domain/src/entities/broadcast-recipient";
import type { Contact } from "@packages/domain/src/entities/contact";
import type { ISODateString } from "@packages/domain/src/entities/common";
import type { BroadcastStatus } from "@packages/domain/src/status/broadcast-status";
import type { ConsentState } from "@packages/domain/src/status/consent-state";
import type { DeliverabilityState } from "@packages/domain/src/status/deliverability-state";
import type { Disposition } from "@packages/domain/src/status/disposition";
import type { RecipientStatus } from "@packages/domain/src/status/recipient-status";
import type { Classification, MetaError } from "@modules/messaging-errors/domain/meta-error-classifier";

// ---------------------------------------------------------------------------
// Generic pagination envelope — recipient fan-out can be thousands of rows,
// so every list read in this module is paginated, never a single fetch-all.
// ---------------------------------------------------------------------------
export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next page; `null` once exhausted. */
  readonly nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// broadcasts
// ---------------------------------------------------------------------------

/**
 * The persisted broadcast row. A superset of the shared `Broadcast` entity
 * (all of `Broadcast`'s fields, unmodified) plus pause state and the
 * audience-build-time skip count. Pause/resume are modeled here as EXTRA
 * fields, NOT as new `BroadcastStatus` values — `packages/domain`'s
 * `BroadcastStatus` union (draft/scheduled/sending/sent/failed) is owned
 * elsewhere and this module must not redefine or extend it. A broadcast
 * that is mid-run but paused keeps `status: "sending"` with `pausedAt` set;
 * resuming just clears `pausedAt`. Cancelling instead moves `status` to the
 * union's own terminal `"failed"` value (legal via `sending -> failed`),
 * which is irreversible — exactly the semantics "cancel" needs and "pause"
 * does not.
 */
export interface BroadcastRecord extends Broadcast {
  readonly pausedAt: ISODateString | null;
  readonly pauseReason: string | null;
  /** Contacts excluded at audience-build time (§4b) — distinct from `failedCount`, which counts send-time failures. */
  readonly skippedCount: number;
}

export interface NewBroadcastInput {
  readonly accountId: AccountId;
  readonly name: string;
  readonly templateId: TemplateId;
  readonly createdBy: UserId;
  readonly scheduledAt: ISODateString | null;
}

/** Filters for the page/pageSize broadcast list read (`BroadcastRepositoryPort.search`). */
export interface BroadcastSearchFilter {
  readonly status?: BroadcastStatus;
  /** Matches `name`, case-insensitively. */
  readonly search?: string;
}

export interface BroadcastSearchPage {
  readonly items: readonly BroadcastRecord[];
  /** Real `COUNT(*)` over the filtered set — not the length of an in-memory walk. */
  readonly total: number;
}

export interface BroadcastRepositoryPort {
  create(input: NewBroadcastInput): Promise<BroadcastRecord>;
  getById(accountId: AccountId, broadcastId: BroadcastId): Promise<BroadcastRecord | null>;
  listForAccount(accountId: AccountId, cursor: string | null, limit: number): Promise<Page<BroadcastRecord>>;
  /**
   * page/pageSize + total read for `GET /api/broadcasts` — status/search
   * filtering and `COUNT(*)` done in SQL, so the route never walks
   * `listForAccount`'s cursor to the end to bridge page/cursor semantics.
   */
  search(
    accountId: AccountId,
    filter: BroadcastSearchFilter,
    page: { readonly page: number; readonly pageSize: number },
  ): Promise<BroadcastSearchPage>;
  updateStatus(accountId: AccountId, broadcastId: BroadcastId, status: BroadcastStatus): Promise<void>;
  setScheduledAt(accountId: AccountId, broadcastId: BroadcastId, scheduledAt: ISODateString | null): Promise<void>;
  /** `pausedAt: null` resumes. `reason` is ignored/cleared when `pausedAt` is `null`. */
  setPaused(
    accountId: AccountId,
    broadcastId: BroadcastId,
    pausedAt: ISODateString | null,
    reason: string | null,
  ): Promise<void>;
  /** Set once, right after the audience is built and recipients are enqueued (§4b: the preview count MUST equal what was actually enqueued). */
  recordAudience(accountId: AccountId, broadcastId: BroadcastId, totalRecipients: number, skippedCount: number): Promise<void>;
  incrementCounts(accountId: AccountId, broadcastId: BroadcastId, delta: { readonly sent: number; readonly failed: number }): Promise<void>;
}

// ---------------------------------------------------------------------------
// broadcast_recipients — fan-out can be thousands of rows: batched writes,
// paginated/keyset reads, and a dedicated queue-draining read backed by the
// (account_id, broadcast_id, status, next_attempt_at) index.
// ---------------------------------------------------------------------------

export interface NewBroadcastRecipientInput {
  readonly accountId: AccountId;
  readonly broadcastId: BroadcastId;
  readonly contactId: ContactId;
}

export interface RecipientOutcomeUpdate {
  readonly status: RecipientStatus;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly disposition: Disposition | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: ISODateString | null;
  readonly wamid?: string | null;
  readonly sentAt?: ISODateString | null;
  readonly deliveredAt?: ISODateString | null;
  readonly readAt?: ISODateString | null;
  readonly repliedAt?: ISODateString | null;
}

export interface BroadcastRecipientRepositoryPort {
  /** Implementations MUST chunk internally — fan-out can be thousands of rows in one call. */
  createMany(inputs: readonly NewBroadcastRecipientInput[]): Promise<void>;
  listByBroadcast(
    accountId: AccountId,
    broadcastId: BroadcastId,
    cursor: string | null,
    limit: number,
  ): Promise<Page<BroadcastRecipient>>;
  /** The queue-draining read: due (status='pending', next_attempt_at <= now or unset), oldest-first, capped at `limit` — backs the (account_id, broadcast_id, status, next_attempt_at) index. `limit` is the pacing-computed batch size (domain/pacing.ts), so this never over-fetches past what the pacing window allows. */
  listDueForSend(
    accountId: AccountId,
    broadcastId: BroadcastId,
    now: ISODateString,
    limit: number,
  ): Promise<readonly BroadcastRecipient[]>;
  listFailed(accountId: AccountId, broadcastId: BroadcastId, cursor: string | null, limit: number): Promise<Page<BroadcastRecipient>>;
  /** `sent_at` timestamps within the pacing window — feeds domain/pacing.ts directly; this is what makes pacing resumable (see pacing.ts's header). */
  listRecentSentAt(accountId: AccountId, broadcastId: BroadcastId, since: ISODateString): Promise<readonly ISODateString[]>;
  getById(accountId: AccountId, recipientId: string): Promise<BroadcastRecipient | null>;
  applyOutcome(accountId: AccountId, recipientId: string, update: RecipientOutcomeUpdate): Promise<void>;
}

// ---------------------------------------------------------------------------
// Contacts — owned by another track (see ports docstring above). Read-only
// from this module's point of view, except for triggering suppression.
// ---------------------------------------------------------------------------

export interface ContactSendState {
  readonly contactId: ContactId;
  readonly deliverabilityState: DeliverabilityState;
  readonly consentState: ConsentState;
  readonly suppressedReasonCode: string | null;
}

export interface AudienceSource {
  /** Candidate contacts for a broadcast, BEFORE suppression/consent filtering — `domain/audience.ts` does that. Paginated: candidate pools can number in the thousands. */
  listCandidates(accountId: AccountId, cursor: string | null, limit: number): Promise<Page<Contact>>;
}

export interface ContactStatePort {
  /** A FRESH, single-contact read — used immediately before dispatch (§4 enforcement point 2). MUST NOT be served from any cache the audience build populated. */
  getSendState(accountId: AccountId, contactId: ContactId): Promise<ContactSendState | null>;
}

/**
 * §4/§5: a PERMANENT_NUMBER failure suppresses the contact. This module
 * triggers that (via `recipient-outcome.ts`'s `RunEffect`) but does not own
 * the `contacts` table — persisting the suppression, and appending to
 * `contact_delivery_events`, is `ContactDeliverabilityService`'s job
 * elsewhere (messaging-errors track).
 */
export interface ContactSuppressionPort {
  suppressForPermanentNumber(
    accountId: AccountId,
    contactId: ContactId,
    reasonCode: string,
    at: ISODateString,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Outbound send + operator alerting — both owned by other tracks
// (WhatsAppProvider / notifications). Declared here as the shapes this
// module depends on when driving a send.
// ---------------------------------------------------------------------------

export interface SendSuccess {
  readonly ok: true;
  readonly wamid: string;
}
export interface SendFailure {
  readonly ok: false;
  readonly error: MetaError;
}
export type SendOutcome = SendSuccess | SendFailure;

export interface MessageDispatchPort {
  sendTemplateMessage(
    accountId: AccountId,
    contactId: ContactId,
    templateId: TemplateId,
    broadcastId: BroadcastId,
  ): Promise<SendOutcome>;
}

export interface OperatorAlertPort {
  /** §4b: "PERMANENT_CONFIG failures notify the account owner, since only they can fix a token, template or billing problem." */
  alertPermanentConfigFailure(accountId: AccountId, broadcastId: BroadcastId, classification: Classification): Promise<void>;
}
