/**
 * Broadcast report — META_ERROR_TAXONOMY.md §4b, "Broadcast report" surface:
 * "Failures grouped by reason, not a flat list of 200 rows: '142 couldn't
 * receive WhatsApp messages · 38 opted out · 12 need an approved template ·
 * 8 will retry automatically'. Each group expandable to the contacts."
 *
 * Grouping key is `errorCode` — every Meta code maps to exactly one
 * `errorMessage` (via the classifier's table), and `pre-send-guard.ts`'s
 * blocks are recorded with their own synthetic codes
 * (SUPPRESSED/OPTED_OUT/DO_NOT_CONTACT — see
 * application/broadcast-service.ts) so the SAME grouping mechanism covers
 * both Meta failures and pre-send blocks without a second code path.
 *
 * Pure — takes whatever rows the application layer paginated in from
 * `BroadcastRecipientRepositoryPort.listByBroadcast`.
 */
import type { Disposition } from "@packages/domain/src/status/disposition";
import { dispositionIsRetryable } from "@packages/domain/src/status/disposition";
import type { RecipientStatus } from "@packages/domain/src/status/recipient-status";

/** The minimal shape this module needs from a recipient row — decoupled from the full `BroadcastRecipient` entity so tests can build fixtures with only what matters here. */
export interface RecipientForReport {
  readonly status: RecipientStatus;
  readonly disposition: Disposition | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface ReportGroup {
  /** `errorCode` (a Meta code, "NETWORK"/"UNKNOWN", or a pre-send-guard synthetic code). */
  readonly errorCode: string;
  /** Customer-facing copy for this group — never a Meta code or raw Meta text (§4b). */
  readonly message: string;
  readonly count: number;
}

export interface BroadcastReport {
  readonly totalRecipients: number;
  /** status in sent/delivered/read/replied — anything that left the queue successfully. */
  readonly deliveredOrSentCount: number;
  /** Terminal failures (status = 'failed'), grouped by reason, counts descending then errorCode for a stable order. */
  readonly failedGroups: readonly ReportGroup[];
  readonly failedCount: number;
  /** Still-pending recipients that have already failed at least once and are waiting on `next_attempt_at` — "N will retry automatically" (§4b). Grouped the same way for the "technical details" disclosure. */
  readonly retryingGroups: readonly ReportGroup[];
  readonly retryingCount: number;
}

const SENT_STATUSES: ReadonlySet<RecipientStatus> = new Set(["sent", "delivered", "read", "replied"]);

function groupByErrorCode(rows: readonly RecipientForReport[]): ReportGroup[] {
  const counts = new Map<string, { message: string; count: number }>();
  for (const row of rows) {
    const code = row.errorCode ?? "UNKNOWN";
    const message = row.errorMessage ?? "Something went wrong sending this message.";
    const existing = counts.get(code);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(code, { message, count: 1 });
    }
  }
  return [...counts.entries()]
    .map(([errorCode, { message, count }]) => ({ errorCode, message, count }))
    .sort((a, b) => b.count - a.count || a.errorCode.localeCompare(b.errorCode));
}

export function buildBroadcastReport(rows: readonly RecipientForReport[]): BroadcastReport {
  const deliveredOrSent = rows.filter((row) => SENT_STATUSES.has(row.status));
  const failed = rows.filter((row) => row.status === "failed");
  // A "will retry automatically" row: still pending, but has already taken
  // at least one failed attempt (disposition/errorCode set by
  // recipient-outcome.ts's applyRecipientFailure, whose retryable outcomes
  // keep status = 'pending' rather than 'failed' — see that file's status
  // modeling note). A pending recipient that simply hasn't been attempted
  // yet has no disposition and does not belong in this group.
  const retrying = rows.filter(
    (row) => row.status === "pending" && row.disposition !== null && dispositionIsRetryable(row.disposition),
  );

  const failedGroups = groupByErrorCode(failed);
  const retryingGroups = groupByErrorCode(retrying);

  return {
    totalRecipients: rows.length,
    deliveredOrSentCount: deliveredOrSent.length,
    failedGroups,
    failedCount: failed.length,
    retryingGroups,
    retryingCount: retrying.length,
  };
}
