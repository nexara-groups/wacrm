/**
 * BroadcastService — orchestrates broadcast create/schedule/audience
 * preview/start/pause/resume/cancel/retry-failed and the paced send loop,
 * over the ports in `./ports.ts`. Never touches SQL directly (architecture
 * guard rule 2) — all persistence goes through the injected ports.
 *
 * Retry-failed bug fix (build brief): the current product's "Retry Failed"
 * button re-queues EVERY failed recipient indiscriminately, including
 * numbers Meta has told us will never work (`PERMANENT_NUMBER`). This
 * service's `retryFailed` only re-queues recipients whose last disposition
 * is retryable (`TRANSIENT`/`THROTTLED`) — see `dispositionIsRetryable`.
 */
import { AppError } from "@shared/errors";
import type { AccountId, BroadcastId } from "@packages/domain/src/ids";
import { canTransitionBroadcastStatus } from "@packages/domain/src/status/broadcast-status";
import { dispositionIsRetryable } from "@packages/domain/src/status/disposition";
import { classify } from "@modules/messaging-errors/domain/meta-error-classifier";
import { buildAudience, mergeAudienceSelections, type AudienceSelection } from "../domain/audience";
import { preSendGuard } from "../domain/pre-send-guard";
import {
  DEFAULT_PACING_LIMITS,
  remainingCapacity,
  type PacingLimits,
} from "../domain/pacing";
import { applyRecipientFailure } from "../domain/recipient-outcome";
import { buildBroadcastReport, type BroadcastReport } from "../domain/broadcast-report";
import type {
  AudienceSource,
  BroadcastRecipientRepositoryPort,
  BroadcastRecord,
  BroadcastRepositoryPort,
  ContactStatePort,
  ContactSuppressionPort,
  MessageDispatchPort,
  NewBroadcastInput,
  OperatorAlertPort,
} from "./ports";

const DEFAULT_PAGE_SIZE = 500;

export interface BroadcastServiceDeps {
  readonly broadcasts: BroadcastRepositoryPort;
  readonly recipients: BroadcastRecipientRepositoryPort;
  readonly audienceSource: AudienceSource;
  readonly contactState: ContactStatePort;
  readonly suppression: ContactSuppressionPort;
  readonly dispatch: MessageDispatchPort;
  readonly alerts: OperatorAlertPort;
  readonly pageSize?: number;
  readonly pacingLimits?: PacingLimits;
  /** Injectable clock for deterministic tests; defaults to `() => new Date()`. */
  readonly clock?: () => Date;
}

export interface ProcessBatchResult {
  readonly sent: number;
  readonly failed: number;
  /** Recipients that never reached the provider because the pre-send guard re-check blocked them (§4 enforcement point 2). */
  readonly blockedByGuard: number;
  /** True when a PERMANENT_CONFIG failure paused the run during this pass. */
  readonly pausedRun: boolean;
}

export interface RetryFailedResult {
  readonly requeued: number;
  /** Recipients skipped because their disposition is not retryable (PERMANENT_NUMBER, PERMANENT_CONFIG) or they have no disposition at all (a pre-send-guard block). */
  readonly skippedNonRetryable: number;
}

export class BroadcastService {
  private readonly pageSize: number;
  private readonly pacingLimits: PacingLimits;
  private readonly clock: () => Date;

  constructor(private readonly deps: BroadcastServiceDeps) {
    this.pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
    this.pacingLimits = deps.pacingLimits ?? DEFAULT_PACING_LIMITS;
    this.clock = deps.clock ?? (() => new Date());
  }

  async createBroadcast(input: NewBroadcastInput): Promise<BroadcastRecord> {
    return this.deps.broadcasts.create(input);
  }

  async scheduleBroadcast(accountId: AccountId, broadcastId: BroadcastId, scheduledAt: Date): Promise<BroadcastRecord> {
    const broadcast = await this.getExisting(accountId, broadcastId);
    if (!canTransitionBroadcastStatus(broadcast.status, "scheduled")) {
      throw AppError.validation(`Cannot schedule a broadcast in status "${broadcast.status}"`);
    }
    await this.deps.broadcasts.setScheduledAt(accountId, broadcastId, scheduledAt.toISOString());
    await this.deps.broadcasts.updateStatus(accountId, broadcastId, "scheduled");
    return this.getExisting(accountId, broadcastId);
  }

  /**
   * §4b audience preview: "3,142 recipients · 180 will be skipped ...". Pages
   * through every candidate contact for the account and merges the
   * per-page `AudienceSelection`s — see `domain/audience.ts`. `startBroadcast`
   * calls this SAME method to decide what to enqueue, so the previewed
   * count and the enqueued count can never structurally drift apart (short
   * of the underlying contact data itself changing between the two calls,
   * which is exactly what `preSendGuard`'s later re-check exists to catch).
   */
  async previewAudience(accountId: AccountId): Promise<AudienceSelection> {
    const selections: AudienceSelection[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.deps.audienceSource.listCandidates(accountId, cursor, this.pageSize);
      selections.push(buildAudience(page.items));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return mergeAudienceSelections(selections);
  }

  /**
   * Builds the audience, enqueues exactly `includedContactIds` as
   * `broadcast_recipients` rows, records the audience counts on the
   * broadcast, and flips it to `sending`.
   */
  async startBroadcast(accountId: AccountId, broadcastId: BroadcastId): Promise<BroadcastRecord> {
    const broadcast = await this.getExisting(accountId, broadcastId);
    if (!canTransitionBroadcastStatus(broadcast.status, "sending")) {
      throw AppError.validation(`Cannot start a broadcast in status "${broadcast.status}"`);
    }

    const selection = await this.previewAudience(accountId);
    if (selection.includedContactIds.length > 0) {
      await this.deps.recipients.createMany(
        selection.includedContactIds.map((contactId) => ({ accountId, broadcastId, contactId })),
      );
    }
    await this.deps.broadcasts.recordAudience(
      accountId,
      broadcastId,
      selection.includedContactIds.length,
      selection.skippedCount,
    );
    await this.deps.broadcasts.updateStatus(accountId, broadcastId, "sending");

    return this.getExisting(accountId, broadcastId);
  }

  async pauseBroadcast(accountId: AccountId, broadcastId: BroadcastId, reason: string): Promise<BroadcastRecord> {
    const broadcast = await this.getExisting(accountId, broadcastId);
    if (broadcast.status !== "sending") {
      throw AppError.validation(`Cannot pause a broadcast in status "${broadcast.status}"`);
    }
    await this.deps.broadcasts.setPaused(accountId, broadcastId, this.clock().toISOString(), reason);
    return this.getExisting(accountId, broadcastId);
  }

  async resumeBroadcast(accountId: AccountId, broadcastId: BroadcastId): Promise<BroadcastRecord> {
    const broadcast = await this.getExisting(accountId, broadcastId);
    if (broadcast.status !== "sending") {
      throw AppError.validation(`Cannot resume a broadcast in status "${broadcast.status}"`);
    }
    if (broadcast.pausedAt === null) {
      throw AppError.validation("Broadcast is not paused");
    }
    await this.deps.broadcasts.setPaused(accountId, broadcastId, null, null);
    return this.getExisting(accountId, broadcastId);
  }

  async cancelBroadcast(accountId: AccountId, broadcastId: BroadcastId): Promise<BroadcastRecord> {
    const broadcast = await this.getExisting(accountId, broadcastId);
    if (!canTransitionBroadcastStatus(broadcast.status, "failed")) {
      throw AppError.validation(`Cannot cancel a broadcast in status "${broadcast.status}"`);
    }
    await this.deps.broadcasts.updateStatus(accountId, broadcastId, "failed");
    // Clear any stale pause flag on the now-terminal row — cancellation is
    // irreversible, unlike a pause, so there is nothing left to "resume".
    await this.deps.broadcasts.setPaused(accountId, broadcastId, null, null);
    return this.getExisting(accountId, broadcastId);
  }

  /**
   * Re-queues only RETRYABLE failed recipients (TRANSIENT/THROTTLED). Never
   * touches PERMANENT_NUMBER (would re-spam a suppressed number) or
   * PERMANENT_CONFIG (would burn attempts against a template/token that
   * will fail identically every time) — this is the fix for "the current
   * product retries everything indiscriminately".
   */
  async retryFailed(accountId: AccountId, broadcastId: BroadcastId): Promise<RetryFailedResult> {
    const now = this.clock();
    let requeued = 0;
    let skippedNonRetryable = 0;
    let cursor: string | null = null;

    do {
      const page = await this.deps.recipients.listFailed(accountId, broadcastId, cursor, this.pageSize);
      for (const recipient of page.items) {
        if (recipient.disposition !== null && dispositionIsRetryable(recipient.disposition)) {
          await this.deps.recipients.applyOutcome(accountId, recipient.id, {
            status: "pending",
            errorCode: recipient.errorCode,
            errorMessage: null,
            disposition: recipient.disposition,
            attemptCount: recipient.attemptCount,
            nextAttemptAt: now.toISOString(),
          });
          requeued += 1;
        } else {
          skippedNonRetryable += 1;
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    return { requeued, skippedNonRetryable };
  }

  /** §4b broadcast report screen — failures (and "will retry automatically") grouped by reason. */
  async getReport(accountId: AccountId, broadcastId: BroadcastId): Promise<BroadcastReport> {
    const rows = [];
    let cursor: string | null = null;
    do {
      const page = await this.deps.recipients.listByBroadcast(accountId, broadcastId, cursor, this.pageSize);
      rows.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return buildBroadcastReport(rows);
  }

  /**
   * Processes one paced batch of due recipients for a broadcast: re-checks
   * the pre-send guard, dispatches, classifies failures, and applies their
   * effects (suppression / run pause). Meant to be called repeatedly (e.g.
   * once per queue-drain tick) — see domain/pacing.ts's header for why that
   * makes this resumable after any interruption.
   */
  async processDueRecipients(accountId: AccountId, broadcastId: BroadcastId): Promise<ProcessBatchResult> {
    const now = this.clock();
    const broadcast = await this.getExisting(accountId, broadcastId);

    if (broadcast.status !== "sending" || broadcast.pausedAt !== null) {
      return { sent: 0, failed: 0, blockedByGuard: 0, pausedRun: broadcast.pausedAt !== null };
    }

    const windowStart = new Date(now.getTime() - this.pacingLimits.windowMs).toISOString();
    const recentSentAt = (await this.deps.recipients.listRecentSentAt(accountId, broadcastId, windowStart)).map(
      (iso) => new Date(iso),
    );
    const capacity = remainingCapacity(this.pacingLimits, recentSentAt, now);
    if (capacity <= 0) {
      return { sent: 0, failed: 0, blockedByGuard: 0, pausedRun: false };
    }

    const due = await this.deps.recipients.listDueForSend(accountId, broadcastId, now.toISOString(), capacity);

    let sent = 0;
    let failed = 0;
    let blockedByGuard = 0;
    let pausedRun = false;

    for (const recipient of due) {
      // §4 enforcement point 2 — a FRESH read, never the audience-build
      // snapshot, immediately before dispatch.
      const state = await this.deps.contactState.getSendState(accountId, recipient.contactId);
      const guard = preSendGuard({
        deliverabilityState: state?.deliverabilityState ?? "unknown",
        consentState: state?.consentState ?? "unknown",
        suppressedReasonCode: state?.suppressedReasonCode ?? undefined,
      });

      if (!guard.allowed) {
        blockedByGuard += 1;
        failed += 1;
        await this.deps.recipients.applyOutcome(accountId, recipient.id, {
          status: "failed",
          errorCode: guard.reason.kind.toUpperCase(),
          errorMessage: guard.message,
          disposition: null,
          attemptCount: recipient.attemptCount + 1,
          nextAttemptAt: null,
        });
        continue;
      }

      // EXTENSION POINT: credit reservation goes HERE — strictly after the
      // guard passes, strictly before dispatch. NOT implemented; see
      // domain/pre-send-guard.ts's header. Nothing below this line may run
      // for a recipient the guard rejected above.

      const outcome = await this.deps.dispatch.sendTemplateMessage(
        accountId,
        recipient.contactId,
        broadcast.templateId,
        broadcastId,
      );

      if (outcome.ok) {
        sent += 1;
        await this.deps.recipients.applyOutcome(accountId, recipient.id, {
          status: "sent",
          errorCode: null,
          errorMessage: null,
          disposition: null,
          attemptCount: recipient.attemptCount + 1,
          nextAttemptAt: null,
          wamid: outcome.wamid,
          sentAt: now.toISOString(),
        });
        recentSentAt.push(now); // keep this pass's local pacing view current
        continue;
      }

      const classification = classify(outcome.error);
      const failureOutcome = applyRecipientFailure({ attemptCount: recipient.attemptCount, classification, now });
      failed += 1;
      await this.deps.recipients.applyOutcome(accountId, recipient.id, {
        status: failureOutcome.status,
        errorCode: failureOutcome.errorCode,
        errorMessage: failureOutcome.errorMessage,
        disposition: failureOutcome.disposition,
        attemptCount: failureOutcome.attemptCount,
        nextAttemptAt: failureOutcome.nextAttemptAt ? failureOutcome.nextAttemptAt.toISOString() : null,
      });

      if (failureOutcome.effect.kind === "suppress_contact") {
        await this.deps.suppression.suppressForPermanentNumber(
          accountId,
          recipient.contactId,
          failureOutcome.effect.reasonCode,
          now.toISOString(),
        );
      } else if (failureOutcome.effect.kind === "pause_run") {
        pausedRun = true;
        await this.deps.broadcasts.setPaused(accountId, broadcastId, now.toISOString(), failureOutcome.effect.operatorAlert);
        await this.deps.alerts.alertPermanentConfigFailure(accountId, broadcastId, classification);
        // A config error (bad template/token) fails identically for every
        // remaining recipient — stop this pass rather than burn the rest
        // of the batch against a guaranteed failure.
        break;
      }
    }

    if (sent > 0 || failed > 0) {
      await this.deps.broadcasts.incrementCounts(accountId, broadcastId, { sent, failed });
    }

    return { sent, failed, blockedByGuard, pausedRun };
  }

  private async getExisting(accountId: AccountId, broadcastId: BroadcastId): Promise<BroadcastRecord> {
    const broadcast = await this.deps.broadcasts.getById(accountId, broadcastId);
    if (!broadcast) {
      throw AppError.notFound(`Broadcast ${broadcastId} not found`);
    }
    return broadcast;
  }
}
