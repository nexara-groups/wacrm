"use client";

/**
 * The compliance-case screen. Honest by construction, per this task's
 * brief: a case is a time-boxed, scoped, audited PERMISSION — never a
 * browsing tool — so every card leads with its scope and its expiry, and
 * nothing here ever renders message content (there is no field to render
 * it from: `/api/platform/compliance-cases*` never calls `readContent`).
 *
 * Listing is scoped to ONE account at a time because
 * `ComplianceCasePort.findActiveForAccount` is the only listing method the
 * port has (see the API route's own header) — there is no fleet-wide case
 * list, so this screen asks for an account id up front rather than
 * pretending to show "all cases".
 */
import { useCallback, useState, type FormEvent } from "react";
import { AlertTriangle, Check, Clock, Loader2, Search, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { ComplianceCaseDTO } from "@/lib/platform-dto";

type ErrorEnvelope = { code: string; laymanMessage: string; operatorHint?: string };
type ApiEnvelope<T> = ({ ok: true } & T) | { ok: false; error: ErrorEnvelope };

async function readJson<T>(res: Response): Promise<ApiEnvelope<T>> {
  return (await res.json()) as ApiEnvelope<T>;
}

const CATEGORY_OPTIONS = [
  "user_complaint",
  "quality_rating_investigation",
  "policy_violation_review",
  "flagged_template",
  "blocked_number_dispute",
  "legal_request",
] as const;

const SCOPE_TYPE_OPTIONS = ["message_ids", "contact", "template", "date_range"] as const;

const STATUS_BADGE: Record<ComplianceCaseDTO["status"], { label: string; variant: "warning" | "success" | "destructive" | "secondary" }> = {
  pending_approval: { label: "Pending second approval", variant: "warning" },
  active: { label: "Active — content readable in scope", variant: "success" },
  expired: { label: "Expired", variant: "destructive" },
  closed: { label: "Closed", variant: "secondary" },
};

function formatScope(case_: ComplianceCaseDTO): string {
  const value = case_.scopeValue as Record<string, unknown>;
  switch (case_.scopeType) {
    case "message_ids":
      return `${(value.messageIds as string[] | undefined)?.length ?? 0} specific message id(s)`;
    case "contact":
      return `one contact (${String(value.contactId)})`;
    case "template":
      return `one template (${String(value.templateId)})`;
    case "date_range":
      return `date range ${String(value.from)} → ${String(value.to)}`;
    default:
      return case_.scopeType;
  }
}

function timeUntil(iso: string | null): string {
  if (iso === null) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return "< 1 hour left";
  if (hours < 48) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

export function ComplianceCasesScreen({
  viewerEmail,
  canOpenOrDecide,
}: {
  viewerEmail: string;
  canOpenOrDecide: boolean;
}) {
  const [accountId, setAccountId] = useState("");
  const [cases, setCases] = useState<readonly ComplianceCaseDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<{ kind: "error" | "info"; text: string; hint?: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openFormVisible, setOpenFormVisible] = useState(false);

  const load = useCallback(async (id: string) => {
    if (id.trim().length === 0) return;
    setLoading(true);
    setBanner(null);
    const res = await fetch(`/api/platform/compliance-cases?accountId=${encodeURIComponent(id)}`);
    const body = await readJson<{ items: ComplianceCaseDTO[] }>(res);
    setLoading(false);
    if (!body.ok) {
      setBanner({ kind: "error", text: body.error.laymanMessage, hint: body.error.operatorHint });
      setCases(null);
      return;
    }
    setCases(body.items);
  }, []);

  const handleSearch = (event: FormEvent) => {
    event.preventDefault();
    void load(accountId);
  };

  const handleOpen = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      accountId: String(form.get("accountId") ?? ""),
      externalRef: String(form.get("externalRef") ?? ""),
      category: String(form.get("category") ?? ""),
      reason: String(form.get("reason") ?? ""),
      scope: buildScope(form),
    };
    setBanner(null);
    const res = await fetch("/api/platform/compliance-cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await readJson<{ case: ComplianceCaseDTO }>(res);
    if (!body.ok) {
      setBanner({ kind: "error", text: body.error.laymanMessage, hint: body.error.operatorHint });
      return;
    }
    setBanner({ kind: "info", text: `Case ${body.case.externalRef} opened. It grants nothing until a second platform_admin approves it.` });
    setOpenFormVisible(false);
    setAccountId(payload.accountId);
    void load(payload.accountId);
  };

  const handleApprove = async (case_: ComplianceCaseDTO) => {
    setBusyId(case_.id);
    setBanner(null);
    const res = await fetch(`/api/platform/compliance-cases/${case_.id}/approve`, { method: "POST" });
    const body = await readJson<{ case: ComplianceCaseDTO }>(res);
    setBusyId(null);
    if (!body.ok) {
      setBanner({ kind: "error", text: body.error.laymanMessage, hint: body.error.operatorHint });
      return;
    }
    setBanner({ kind: "info", text: `Case ${body.case.externalRef} approved — expires ${body.case.expiresAt}.` });
    void load(accountId);
  };

  const handleClose = async (case_: ComplianceCaseDTO) => {
    const outcome = window.prompt(`Close case ${case_.externalRef} — what was the outcome?`);
    if (outcome === null || outcome.trim().length < 3) return;
    setBusyId(case_.id);
    setBanner(null);
    const res = await fetch(`/api/platform/compliance-cases/${case_.id}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome }),
    });
    const body = await readJson<{ case: ComplianceCaseDTO }>(res);
    setBusyId(null);
    if (!body.ok) {
      setBanner({ kind: "error", text: body.error.laymanMessage, hint: body.error.operatorHint });
      return;
    }
    setBanner({ kind: "info", text: `Case ${body.case.externalRef} closed. Access ended immediately.` });
    void load(accountId);
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Compliance cases</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A case is a time-boxed, scoped, audited permission — never a browsing tool. Signed in as{" "}
            {viewerEmail}.
          </p>
        </div>
        {canOpenOrDecide && (
          <Button size="sm" onClick={() => setOpenFormVisible((v) => !v)}>
            {openFormVisible ? "Cancel" : "Open a case"}
          </Button>
        )}
      </div>

      {banner && (
        <div
          className={`mb-4 flex items-start gap-2 rounded-lg border p-3 text-sm ${
            banner.kind === "error"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
          }`}
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p>{banner.text}</p>
            {banner.hint && <p className="mt-0.5 text-xs opacity-80">{banner.hint}</p>}
          </div>
        </div>
      )}

      {openFormVisible && canOpenOrDecide && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Open a compliance case</CardTitle>
            <CardDescription>
              Scope is declared now, before any access exists. Opening grants nothing by itself — a
              different platform_admin (or a platform_superadmin) must approve before anything in scope
              becomes readable.
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleOpen}>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="accountId">Account id (UUID)</Label>
                <Input id="accountId" name="accountId" required placeholder="account uuid" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="externalRef">Meta / complaint reference</Label>
                <Input id="externalRef" name="externalRef" required placeholder="META-CASE-2026-…" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="category">Category</Label>
                <Select id="category" name="category" required defaultValue="">
                  <option value="" disabled>
                    Select…
                  </option>
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c.replaceAll("_", " ")}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="scopeType">Scope type</Label>
                <Select id="scopeType" name="scopeType" required defaultValue="">
                  <option value="" disabled>
                    Select…
                  </option>
                  {SCOPE_TYPE_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s.replaceAll("_", " ")}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="scopeInput">
                  Scope value — a single id for message_ids/contact/template, or{" "}
                  <code>from,to</code> (ISO timestamps) for date_range
                </Label>
                <Input id="scopeInput" name="scopeInput" required placeholder="e.g. one contact id" />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="reason">Reason — what Meta asked, in full</Label>
                <Textarea id="reason" name="reason" required minLength={10} rows={3} />
              </div>
            </CardContent>
            <CardFooter>
              <Button type="submit" size="sm">
                Open case
              </Button>
            </CardFooter>
          </form>
        </Card>
      )}

      <form onSubmit={handleSearch} className="mb-4 flex gap-2">
        <Input
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder="Account id (UUID) — required, this port lists one account at a time"
          className="max-w-md"
        />
        <Button type="submit" size="sm" variant="outline" disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
          View cases
        </Button>
      </form>

      {cases === null ? (
        <EmptyState
          icon={Search}
          title="Enter an account id"
          description="Compliance cases can only be listed one account at a time — there is no fleet-wide case list."
        />
      ) : cases.length === 0 ? (
        <EmptyState icon={ShieldAlert} title="No open cases for this account" />
      ) : (
        <div className="flex flex-col gap-3">
          {cases.map((case_) => {
            const status = STATUS_BADGE[case_.status];
            return (
              <Card key={case_.id}>
                <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {case_.externalRef}
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </CardTitle>
                    <CardDescription>{case_.category.replaceAll("_", " ")}</CardDescription>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3.5" />
                    {timeUntil(case_.expiresAt)}
                  </div>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <p>
                    <span className="text-muted-foreground">Scope: </span>
                    {formatScope(case_)}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Reason: </span>
                    {case_.reason}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Opened by {case_.openedBy}
                    {case_.approvedBy ? ` · approved by ${case_.approvedBy}` : " · not yet approved"}
                    {case_.expiresAt ? ` · expires ${case_.expiresAt}` : ""}
                  </p>
                </CardContent>
                {canOpenOrDecide && case_.status !== "closed" && (
                  <CardFooter className="gap-2">
                    {case_.status === "pending_approval" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === case_.id}
                        onClick={() => void handleApprove(case_)}
                      >
                        <Check className="size-4" /> Approve
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busyId === case_.id}
                      onClick={() => void handleClose(case_)}
                    >
                      <X className="size-4" /> Close
                    </Button>
                  </CardFooter>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function buildScope(form: FormData): unknown {
  const scopeType = String(form.get("scopeType") ?? "");
  const raw = String(form.get("scopeInput") ?? "").trim();
  switch (scopeType) {
    case "message_ids":
      return { scopeType, scopeValue: { messageIds: [raw] } };
    case "contact":
      return { scopeType, scopeValue: { contactId: raw } };
    case "template":
      return { scopeType, scopeValue: { templateId: raw } };
    case "date_range": {
      const [from, to] = raw.split(",").map((s) => s.trim());
      return { scopeType, scopeValue: { from, to } };
    }
    default:
      return { scopeType: "contact", scopeValue: { contactId: raw } };
  }
}
