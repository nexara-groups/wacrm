"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Loader2, Pause, Play, X } from "lucide-react";
import type { Broadcast, BroadcastActionResponse, BroadcastReport, ScheduleBroadcastResponse } from "@packages/contracts/src/broadcasts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BroadcastStatusBadge, RetryabilityBadge } from "@/components/broadcasts/status-badges";

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value.toLocaleString("en-US")}</p>
    </div>
  );
}

export function BroadcastDetail({
  broadcast,
  report,
  templateName,
}: {
  broadcast: Broadcast;
  report: BroadcastReport;
  templateName: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduledAt, setScheduledAt] = useState("");

  const isPaused = broadcast.status === "sending" && broadcast.pausedAt !== null;
  const canPause = broadcast.status === "sending" && !isPaused;
  const canResume = isPaused;
  const canCancel = broadcast.status === "scheduled" || broadcast.status === "sending";
  const canSchedule = broadcast.status === "draft";

  async function runAction(action: "pause" | "resume" | "cancel") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/broadcasts/${broadcast.id}/${action}`, { method: "POST" });
      const body = (await res.json()) as BroadcastActionResponse;
      if (!body.ok) {
        setError(body.error.laymanMessage);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSchedule() {
    if (!scheduledAt) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/broadcasts/${broadcast.id}/schedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ broadcastId: broadcast.id, scheduledAt: new Date(scheduledAt).toISOString() }),
      });
      const body = (await res.json()) as ScheduleBroadcastResponse;
      if (!body.ok) {
        setError(body.error.laymanMessage);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{broadcast.name}</h1>
            <BroadcastStatusBadge status={broadcast.status} pausedAt={broadcast.pausedAt} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Template: {templateName ?? "(unknown)"}
            {broadcast.scheduledAt && <> · Scheduled for {new Date(broadcast.scheduledAt).toLocaleString()}</>}
          </p>
          {isPaused && broadcast.pauseReason && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Paused: {broadcast.pauseReason}</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {canPause && (
            <Button variant="outline" disabled={busy} onClick={() => runAction("pause")}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Pause className="size-4" />}
              Pause
            </Button>
          )}
          {canResume && (
            <Button variant="outline" disabled={busy} onClick={() => runAction("resume")}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Resume
            </Button>
          )}
          {canCancel && (
            <Button variant="ghost" disabled={busy} onClick={() => runAction("cancel")}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
              Cancel
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {canSchedule && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="size-4" />
              Schedule this broadcast
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <div className="max-w-xs">
              <Label htmlFor="reschedule-at">Send at</Label>
              <Input
                id="reschedule-at"
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="mt-1"
              />
            </div>
            <Button disabled={busy || !scheduledAt} onClick={handleSchedule}>
              Schedule
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Delivery report</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
            <StatTile label="Total" value={broadcast.totalRecipients} />
            <StatTile label="Sent" value={report.sentCount} />
            <StatTile label="Delivered" value={report.deliveredCount} />
            <StatTile label="Read" value={report.readCount} />
            <StatTile label="Failed" value={report.failedCount} />
            <StatTile label="Pending" value={report.pendingCount} />
          </div>

          {broadcast.skippedCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {broadcast.skippedCount.toLocaleString("en-US")} contact{broadcast.skippedCount === 1 ? "" : "s"} were
              skipped when this broadcast's audience was built (opted out, do-not-contact, or can&apos;t receive
              WhatsApp) — they were never queued to send.
            </p>
          )}

          {report.willRetryCount > 0 && (
            <p className="text-sm">
              <Badge variant="warning">{report.willRetryCount.toLocaleString("en-US")} will retry automatically</Badge>
            </p>
          )}

          {report.failureGroups.length > 0 ? (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">Failures, grouped by reason</p>
              <ul className="space-y-2">
                {report.failureGroups.map((group) => (
                  <li key={group.code} className="flex items-start justify-between gap-3 text-sm">
                    <div>
                      <p>{group.laymanMessage}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Meta code {group.code}</span>
                        <RetryabilityBadge disposition={group.disposition} />
                      </p>
                    </div>
                    <Badge variant="outline">{group.count.toLocaleString("en-US")}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            broadcast.totalRecipients > 0 && (
              <p className="text-sm text-muted-foreground">No failures recorded for this broadcast.</p>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
