"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2, Megaphone, Pause, Play, Plus, Search, X } from "lucide-react";
import type { Broadcast, BroadcastActionResponse, ListBroadcastsResponse } from "@packages/contracts/src/broadcasts";
import type { BroadcastStatus } from "@packages/contracts/src/common/vocab";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { BroadcastStatusBadge } from "@/components/broadcasts/status-badges";

const PAGE_SIZE = 20;

const STATUS_OPTIONS: readonly { value: BroadcastStatus | ""; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "scheduled", label: "Scheduled" },
  { value: "sending", label: "Sending" },
  { value: "sent", label: "Sent" },
  { value: "failed", label: "Cancelled" },
];

export interface BroadcastsPage {
  readonly items: readonly Broadcast[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
    readonly totalPages: number;
    readonly from: number;
    readonly to: number;
    readonly hasPrevious: boolean;
    readonly hasNext: boolean;
  };
}

async function fetchBroadcasts(search: string, status: string, page: number): Promise<BroadcastsPage> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (search.trim().length > 0) params.set("search", search.trim());
  if (status) params.set("status", status);

  const res = await fetch(`/api/broadcasts?${params.toString()}`);
  const body = (await res.json()) as ListBroadcastsResponse;
  if (!body.ok) throw new Error(body.error.laymanMessage);
  return body;
}

function progressLabel(broadcast: Broadcast): string {
  if (broadcast.totalRecipients === 0) {
    return broadcast.status === "draft" || broadcast.status === "scheduled" ? "Not started" : "0 recipients";
  }
  const attempted = broadcast.sentCount + broadcast.failedCount;
  return `${attempted.toLocaleString("en-US")} / ${broadcast.totalRecipients.toLocaleString("en-US")}`;
}

export function BroadcastsTable({ initial }: { initial: BroadcastsPage }) {
  const router = useRouter();
  const [data, setData] = useState<BroadcastsPage>(initial);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const requestSeq = useRef(0);

  const reload = useCallback((nextSearch: string, nextStatus: string, nextPage: number) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    fetchBroadcasts(nextSearch, nextStatus, nextPage)
      .then((result) => {
        if (seq !== requestSeq.current) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seq !== requestSeq.current) return;
        setLoading(false);
      });
  }, []);

  // The server component that renders this table already fetched exactly
  // this page (`initial`), so refetching it on mount reads every row a
  // second time for a result the browser is already displaying. On the free
  // tier rows READ is the metered quantity, so that doubled the cost of
  // simply opening the screen. The effect below now runs only once the
  // operator has actually changed something.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    const handle = setTimeout(() => {
      setPage(1);
      reload(search, status, 1);
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status]);

  function goToPage(next: number) {
    setPage(next);
    reload(search, status, next);
  }

  async function runAction(broadcastId: string, action: "pause" | "resume" | "cancel") {
    setActioningId(broadcastId);
    setError(null);
    try {
      const res = await fetch(`/api/broadcasts/${broadcastId}/${action}`, { method: "POST" });
      const body = (await res.json()) as BroadcastActionResponse;
      if (!body.ok) {
        setError(body.error.laymanMessage);
        return;
      }
      reload(search, status, page);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActioningId(null);
    }
  }

  const broadcasts = data.items;
  const { pagination } = data;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Broadcasts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {pagination.total > 0
              ? `${pagination.total} broadcast${pagination.total === 1 ? "" : "s"}`
              : "No broadcasts yet"}
          </p>
        </div>
        <Button onClick={() => router.push("/broadcasts/new")}>
          <Plus className="size-4" />
          New broadcast
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full max-w-sm">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name…"
            className="pl-8"
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-48">
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Audience</TableHead>
              <TableHead className="hidden md:table-cell">Progress</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">Loading…</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : broadcasts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={Megaphone}
                    title={search.trim().length > 0 || status ? "No broadcasts match your filters." : "No broadcasts yet."}
                    description="Create a broadcast to message a filtered set of contacts through an approved template."
                  />
                </TableCell>
              </TableRow>
            ) : (
              broadcasts.map((broadcast) => {
                const isActioning = actioningId === broadcast.id;
                const isPaused = broadcast.status === "sending" && broadcast.pausedAt !== null;
                const canPause = broadcast.status === "sending" && !isPaused;
                const canResume = isPaused;
                const canCancel = broadcast.status === "scheduled" || broadcast.status === "sending";
                return (
                  <TableRow key={broadcast.id}>
                    <TableCell className="font-medium">
                      <Link href={`/broadcasts/${broadcast.id}`} className="hover:underline">
                        {broadcast.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <BroadcastStatusBadge status={broadcast.status} pausedAt={broadcast.pausedAt} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {broadcast.totalRecipients.toLocaleString("en-US")}
                      {broadcast.skippedCount > 0 && (
                        <span className="ml-1 text-xs">({broadcast.skippedCount.toLocaleString("en-US")} skipped)</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                      {progressLabel(broadcast)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {canPause && (
                          <Button
                            variant="outline"
                            size="icon-sm"
                            title="Pause"
                            disabled={isActioning}
                            onClick={() => runAction(broadcast.id, "pause")}
                          >
                            {isActioning ? <Loader2 className="size-4 animate-spin" /> : <Pause className="size-4" />}
                          </Button>
                        )}
                        {canResume && (
                          <Button
                            variant="outline"
                            size="icon-sm"
                            title="Resume"
                            disabled={isActioning}
                            onClick={() => runAction(broadcast.id, "resume")}
                          >
                            {isActioning ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                          </Button>
                        )}
                        {canCancel && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Cancel"
                            disabled={isActioning}
                            onClick={() => runAction(broadcast.id, "cancel")}
                          >
                            {isActioning ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {pagination.from}–{pagination.to} of {pagination.total}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!pagination.hasPrevious || loading}
              onClick={() => goToPage(page - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="px-2 text-xs text-muted-foreground">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!pagination.hasNext || loading}
              onClick={() => goToPage(page + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
