/**
 * Maps broadcasts-module persistence records and pure-domain results onto
 * the wire shapes in `@packages/contracts/src/broadcasts`. Same discipline
 * as `contact-dto.ts`: every mapper parses its output through the contract
 * schema, so a field that drifts between the port and the wire shape throws
 * a `ZodError` here instead of silently shipping a response with something
 * missing.
 *
 * One vocabulary mismatch is still open and is NOT papered over here:
 * `audienceSkipReasonSchema` enumerates five skip reasons, while
 * `modules/broadcasts/domain/audience.ts` only ever produces three
 * (`cannot_receive`, `opted_out`, `do_not_contact`). `duplicate_contact`
 * and `invalid_phone_number` are wire vocabulary the domain does not yet
 * implement, so those groups can never appear in a preview. That is a real
 * gap in audience building, not a mapping problem, and inventing values for
 * them here would hide it.
 */
import {
  audiencePreviewSchema,
  broadcastReportSchema,
  broadcastSchema,
  type AudiencePreview,
  type AudienceSkipReason,
  type Broadcast,
  type BroadcastReport,
} from "@packages/contracts/src/broadcasts";
import type { Disposition } from "@packages/contracts/src/common/vocab";
import type { BroadcastRecord } from "@modules/broadcasts/application/ports";
import type { AudienceSelection, AudienceSkipReasonKind } from "@modules/broadcasts/domain/audience";
import { formatAudiencePreview } from "@modules/broadcasts/domain/audience";
import { buildBroadcastReport } from "@modules/broadcasts/domain/broadcast-report";
import type { BroadcastRecipient } from "@packages/domain/src/entities/broadcast-recipient";

export function toBroadcastDTO(record: BroadcastRecord): Broadcast {
  return broadcastSchema.parse({
    id: record.id,
    accountId: record.accountId,
    name: record.name,
    templateId: record.templateId,
    status: record.status,
    scheduledAt: record.scheduledAt,
    createdBy: record.createdBy,
    totalRecipients: record.totalRecipients,
    sentCount: record.sentCount,
    failedCount: record.failedCount,
    pausedAt: record.pausedAt,
    pauseReason: record.pauseReason,
    skippedCount: record.skippedCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

const SKIP_REASON_KIND_TO_WIRE: Record<AudienceSkipReasonKind, AudienceSkipReason> = {
  cannot_receive: "suppressed_number",
  opted_out: "opted_out",
  do_not_contact: "do_not_contact",
};

/**
 * `AudienceSelection` -> the wire `AudiencePreview`.
 *
 * Every count comes off the SAME selection object `buildAudience` produced,
 * so `audiencePreviewSchema`'s two refinements — §4b's "the number they see
 * is the number that goes out" — hold by construction rather than by
 * re-summing here and hoping the two agree.
 */
export function toAudiencePreviewDTO(selection: AudienceSelection): AudiencePreview {
  return audiencePreviewSchema.parse({
    totalMatchedCount: selection.totalConsidered,
    willSendCount: selection.includedContactIds.length,
    skippedCount: selection.skippedCount,
    skippedGroups: selection.skipped.map((group) => ({
      reason: SKIP_REASON_KIND_TO_WIRE[group.reason.kind],
      count: group.contactIds.length,
      label: group.reason.label,
    })),
    summary: formatAudiencePreview(selection),
  });
}

/**
 * A recipient blocked by the pre-send guard is stored with `status:
 * "failed"` and `disposition: null` — it never reached Meta, so it has no
 * Meta disposition to carry. `broadcastFailureGroupSchema` requires one.
 *
 * PERMANENT_NUMBER is the faithful answer: the guard blocks because THIS
 * NUMBER must not be messaged (opted out, do-not-contact, or suppressed),
 * and that is exactly what PERMANENT_NUMBER means to every reader —
 * never retry this number. PERMANENT_CONFIG would be actively misleading:
 * it means "your token, template or billing is broken", and it is the
 * disposition that alerts the account owner. Sending an owner to check
 * their Meta configuration because a customer opted out would be a bug
 * with a support ticket attached.
 */
const GUARD_BLOCKED_DISPOSITION: Disposition = "PERMANENT_NUMBER";
const FALLBACK_LAYMAN_MESSAGE = "We couldn't send this message.";

function buildFailureGroups(rows: readonly BroadcastRecipient[]): BroadcastReport["failureGroups"] {
  const byCode = new Map<string, { disposition: Disposition; laymanMessage: string; count: number }>();

  for (const row of rows) {
    if (row.status !== "failed") continue;
    const code = row.errorCode ?? "UNKNOWN";
    const existing = byCode.get(code);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byCode.set(code, {
      disposition: row.disposition ?? GUARD_BLOCKED_DISPOSITION,
      laymanMessage: row.errorMessage ?? FALLBACK_LAYMAN_MESSAGE,
      count: 1,
    });
  }

  // Biggest group first — an operator reading a failure report wants the
  // thing that hit the most people at the top. Ties break on code so the
  // order is stable between renders.
  return [...byCode.entries()]
    .map(([code, value]) => ({ code, ...value }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/**
 * Every recipient row for one broadcast -> the wire `BroadcastReport`.
 *
 * The per-status tallies are counted here because the contract wants a
 * finer breakdown than `domain/broadcast-report.ts` produces — that module
 * only separates "delivered-or-sent" from "failed". `willRetryCount` still
 * comes from `buildBroadcastReport`, because "which failures retry
 * automatically" is a real domain rule (it depends on disposition, not
 * status) and re-deriving it here is how the two would drift apart.
 */
export function toBroadcastReportDTO(
  broadcast: BroadcastRecord,
  rows: readonly BroadcastRecipient[],
): BroadcastReport {
  let sentCount = 0;
  let deliveredCount = 0;
  let readCount = 0;
  let failedCount = 0;
  let pendingCount = 0;

  for (const row of rows) {
    switch (row.status) {
      case "sent":
        sentCount += 1;
        break;
      case "delivered":
        deliveredCount += 1;
        break;
      case "read":
      case "replied":
        // A reply implies a read, and the contract has no separate replied
        // count, so both land in `readCount`.
        readCount += 1;
        break;
      case "failed":
        failedCount += 1;
        break;
      case "pending":
        pendingCount += 1;
        break;
    }
  }

  return broadcastReportSchema.parse({
    broadcast: toBroadcastDTO(broadcast),
    sentCount,
    deliveredCount,
    readCount,
    failedCount,
    pendingCount,
    willRetryCount: buildBroadcastReport(rows).retryingCount,
    failureGroups: buildFailureGroups(rows),
  });
}
