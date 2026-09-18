"use client";

import { useCallback, useState } from "react";
import { Loader2, UserPlus, Users, X, RotateCcw } from "lucide-react";
import type { AccountMember, Invitation } from "@packages/contracts/src/invitations";
import type { SeatUsage } from "@packages/contracts/src/seats";
import type { PaginationMeta } from "@packages/contracts/src/common/pagination";
import type { SeatLimitSource } from "@/lib/seat-dto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";

export interface TeamScreenInitial {
  readonly usage: SeatUsage;
  readonly limitSource: SeatLimitSource;
  readonly members: {
    readonly items: readonly AccountMember[];
    readonly pagination: PaginationMeta;
    readonly pendingInvitations: readonly Invitation[];
  };
}

const LIMIT_SOURCE_LABEL: Record<SeatLimitSource, string> = {
  account_override: "set for this account",
  plan: "from plan",
  platform_default: "platform default",
};

type ErrorEnvelope = { laymanMessage: string; operatorHint?: string };
type ApiEnvelope<T> = ({ ok: true } & T) | { ok: false; error: ErrorEnvelope };

async function readJson<T>(res: Response): Promise<ApiEnvelope<T>> {
  return (await res.json()) as ApiEnvelope<T>;
}

export function TeamScreen({ initial }: { initial: TeamScreenInitial }) {
  const [usage, setUsage] = useState(initial.usage);
  const [limitSource, setLimitSource] = useState(initial.limitSource);
  const [members, setMembers] = useState<readonly AccountMember[]>(initial.members.items);
  const [pendingInvitations, setPendingInvitations] = useState<readonly Invitation[]>(
    initial.members.pendingInvitations,
  );
  const [inviteOpen, setInviteOpen] = useState(false);
  const [banner, setBanner] = useState<{ kind: "error" | "info"; text: string; hint?: string } | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [seatsRes, membersRes] = await Promise.all([
      fetch("/api/seats"),
      fetch("/api/members?pageSize=100"),
    ]);
    const seatsBody = await readJson<{ usage: SeatUsage; limitSource: SeatLimitSource }>(seatsRes);
    if (seatsBody.ok) {
      setUsage(seatsBody.usage);
      setLimitSource(seatsBody.limitSource);
    }
    const membersBody = await readJson<{
      items: readonly AccountMember[];
      pendingInvitations: readonly Invitation[];
    }>(membersRes);
    if (membersBody.ok) {
      setMembers(membersBody.items);
      setPendingInvitations(membersBody.pendingInvitations);
    }
  }, []);

  async function handleRemove(member: AccountMember) {
    setBusyId(member.userId);
    setBanner(null);
    try {
      const res = await fetch(`/api/members/${member.userId}`, { method: "DELETE" });
      const body = await readJson<Record<string, never>>(res);
      if (!body.ok) {
        setBanner({ kind: "error", text: body.error.laymanMessage, hint: body.error.operatorHint });
        return;
      }
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  async function handleReactivate(member: AccountMember) {
    setBusyId(member.userId);
    setBanner(null);
    try {
      const res = await fetch(`/api/members/${member.userId}`, { method: "PATCH" });
      const body = await readJson<{ member: AccountMember }>(res);
      if (!body.ok) {
        setBanner({ kind: "error", text: body.error.laymanMessage, hint: body.error.operatorHint });
        return;
      }
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  async function handleRevoke(invitation: Invitation) {
    setBusyId(invitation.id);
    setBanner(null);
    try {
      const res = await fetch(`/api/invitations/${invitation.id}`, { method: "DELETE" });
      const body = await readJson<Record<string, never>>(res);
      if (!body.ok) {
        setBanner({ kind: "error", text: body.error.laymanMessage, hint: body.error.operatorHint });
        return;
      }
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Team</h1>
          <p className="mt-1 text-sm text-muted-foreground">Members, seats, and pending invitations.</p>
        </div>
        <Button onClick={() => setInviteOpen((v) => !v)}>
          <UserPlus className="size-4" />
          Invite
        </Button>
      </div>

      <SeatUsageCard usage={usage} limitSource={limitSource} />

      {banner && (
        <div
          className={
            banner.kind === "error"
              ? "space-y-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              : "space-y-1 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm"
          }
        >
          <p>{banner.text}</p>
          {banner.hint && <p className="text-xs opacity-80">{banner.hint}</p>}
        </div>
      )}

      {inviteOpen && (
        <InviteForm
          onInvited={() => {
            setInviteOpen(false);
            void reload();
          }}
          onCapHit={(text, hint) => setBanner({ kind: "error", text, hint })}
          onCancel={() => setInviteOpen(false)}
        />
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Members ({members.length})
        </h2>
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="p-0">
                    <EmptyState icon={Users} title="No members yet" />
                  </TableCell>
                </TableRow>
              ) : (
                members.map((member) => (
                  <TableRow key={member.userId}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {member.userId}
                    </TableCell>
                    <TableCell className="capitalize">{member.role}</TableCell>
                    <TableCell>
                      <StatusBadge status={member.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      {member.role === "owner" ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : member.status === "deactivated" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyId === member.userId}
                          onClick={() => void handleReactivate(member)}
                        >
                          {busyId === member.userId ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="size-3.5" />
                          )}
                          Reactivate
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyId === member.userId}
                          onClick={() => void handleRemove(member)}
                        >
                          {busyId === member.userId ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <X className="size-3.5" />
                          )}
                          Remove
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Pending invitations ({pendingInvitations.length})
        </h2>
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pendingInvitations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="p-0">
                    <EmptyState icon={Users} title="No pending invitations" />
                  </TableCell>
                </TableRow>
              ) : (
                pendingInvitations.map((invitation) => {
                  const expired = new Date(invitation.expiresAt).getTime() < Date.now();
                  return (
                    <TableRow key={invitation.id}>
                      <TableCell className="text-sm">{invitation.email}</TableCell>
                      <TableCell className="capitalize">{invitation.role}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(invitation.expiresAt).toLocaleString()}
                        {expired && (
                          <Badge variant="warning" className="ml-2">
                            expired
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyId === invitation.id}
                          onClick={() => void handleRevoke(invitation)}
                        >
                          {busyId === invitation.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <X className="size-3.5" />
                          )}
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: AccountMember["status"] }) {
  if (status === "active") return <Badge variant="success">active</Badge>;
  if (status === "deactivated") return <Badge variant="warning">deactivated</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

function SeatUsageCard({ usage, limitSource }: { usage: SeatUsage; limitSource: SeatLimitSource }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Seats</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-2xl font-bold">
          {usage.used} <span className="text-base font-normal text-muted-foreground">/ {usage.limit}</span>
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            ({LIMIT_SOURCE_LABEL[limitSource]})
          </span>
        </p>
        {usage.isOverSeatLimit && (
          <Badge variant="destructive">Over seat limit — new invitations blocked</Badge>
        )}
        {usage.statusMessage && (
          <p className="text-sm text-muted-foreground">{usage.statusMessage}</p>
        )}
      </CardContent>
    </Card>
  );
}

function InviteForm({
  onInvited,
  onCapHit,
  onCancel,
}: {
  onInvited: () => void;
  onCapHit: (text: string, hint?: string) => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFieldErrors({});
    try {
      const res = await fetch("/api/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const body = await readJson<{ invitation: Invitation }>(res);
      if (!body.ok) {
        if (body.error.laymanMessage && !("fieldErrors" in body.error)) {
          onCapHit(body.error.laymanMessage, body.error.operatorHint);
        }
        const withFields = body.error as ErrorEnvelope & { fieldErrors?: Record<string, string[]> };
        setFieldErrors(withFields.fieldErrors ?? {});
        return;
      }
      onInvited();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-4"
    >
      <div className="sm:col-span-2">
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          type="email"
          required
        />
        {fieldErrors.email && <p className="mt-1 text-xs text-destructive">{fieldErrors.email[0]}</p>}
      </div>
      <div className="sm:col-span-1">
        <Select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">Member</option>
          <option value="manager">Manager</option>
          <option value="admin">Admin</option>
        </Select>
      </div>
      <div className="flex items-center gap-2 sm:col-span-1">
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          Send invite
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
