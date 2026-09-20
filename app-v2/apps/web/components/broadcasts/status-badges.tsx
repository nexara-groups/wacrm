import type { Broadcast } from "@packages/contracts/src/broadcasts";
import type { Disposition } from "@packages/contracts/src/common/vocab";
import { Badge, type BadgeProps } from "@/components/ui/badge";

const STATUS_LABEL: Record<Broadcast["status"], string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  failed: "Cancelled",
};

const STATUS_VARIANT: Record<Broadcast["status"], BadgeProps["variant"]> = {
  draft: "outline",
  scheduled: "secondary",
  sending: "success",
  sent: "success",
  failed: "destructive",
};

/**
 * A paused broadcast is NOT a distinct `BroadcastStatus` value — it keeps
 * `status: "sending"` with `pausedAt` set (see `BroadcastRecord`'s
 * docstring). This renders that combination distinctly from a run that is
 * actually in progress, per the build brief ("render that distinctly from
 * a running one").
 *
 * `"failed"` is rendered as "Cancelled" rather than the literal status
 * name: in this UI a broadcast only ever reaches `failed` via the cancel
 * action or an automatic PERMANENT_CONFIG stop (never a partial-send
 * failure — recipient-level failures live on individual recipients, not
 * the broadcast's own status) — "Cancelled" is what an operator did or
 * would recognise, "Failed" reads as a crash.
 */
export function BroadcastStatusBadge({ status, pausedAt }: { status: Broadcast["status"]; pausedAt: string | null }) {
  if (status === "sending" && pausedAt !== null) {
    return <Badge variant="warning">Paused</Badge>;
  }
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}

/**
 * Consent and deliverability are independent axes (META_ERROR_TAXONOMY.md
 * §3b): a `PERMANENT_NUMBER`/`PERMANENT_CONFIG` failure is a definitive
 * stop, `TRANSIENT`/`THROTTLED` retries automatically. Never rendered as
 * clearable — there is no control anywhere in this slice that clears an
 * opt-out or a permanent disposition.
 */
export function RetryabilityBadge({ disposition }: { disposition: Disposition }) {
  const retryable = disposition === "TRANSIENT" || disposition === "THROTTLED";
  return (
    <Badge variant={retryable ? "warning" : "destructive"}>
      {retryable ? "Will retry automatically" : "Will not retry"}
    </Badge>
  );
}
