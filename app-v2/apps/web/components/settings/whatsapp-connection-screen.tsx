"use client";

import { useEffect, useState } from "react";
import { Loader2, PhoneOutgoing, Save } from "lucide-react";
import type {
  GetWhatsappConnectionResponse,
  SaveWhatsappConnectionResponse,
  WhatsappConnection,
} from "@packages/contracts/src/onboarding";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  isConnectionFormValid,
  REGISTRATION_STATE_LABEL,
  REGISTRATION_STATE_VARIANT,
  REPLACE_CONNECTION_WARNING,
  requiresReplaceConfirmation,
  selectSaveErrorMessage,
  type WhatsappConnectionFormFields,
} from "@/lib/whatsapp-connection-form";

/**
 * Client component: this screen has no server-rendered initial data to
 * hydrate from — `GET /api/whatsapp/connection` applies the tenant:manage-
 * gated, token-stripping mapping (`toConnectionDTO` in that route), and
 * duplicating that here in a Server Component would mean re-deciding, in a
 * second place, what a tenant is allowed to see. So this fetches once on
 * mount instead. Note the difference from `TemplatesTable`'s `hydrated` ref:
 * there, a server-rendered page must NOT be refetched; here there is no
 * initial prop to protect, so the fetch effect is guarded only by its
 * `cancelled` flag — see the comment on that effect for why a ref would
 * actively break it.
 */
export function WhatsappConnectionScreen() {
  const [connection, setConnection] = useState<WhatsappConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // No "have I already fetched?" ref here, deliberately. React StrictMode
  // invokes an effect twice on mount and runs the first invocation's cleanup
  // in between. With such a ref the second invocation returns early, so the
  // ONLY in-flight request belongs to the closure the cleanup already marked
  // cancelled — its `finally` then skips `setLoading(false)` and the screen
  // sits on "Loading…" forever. That is exactly what this screen did in
  // `next dev` until a browser check caught it; production, which invokes
  // once, hid the bug. The `cancelled` flag alone is the right guard: one
  // request in production, two harmless GETs in dev, and the last one to
  // arrive sets the state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/whatsapp/connection");
        const body = (await res.json()) as GetWhatsappConnectionResponse;
        if (cancelled) return;
        if (!body.ok) {
          setLoadError(body.error.laymanMessage);
          return;
        }
        setConnection(body.connection);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">WhatsApp connection</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The WhatsApp Business number this account sends messages from.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      ) : loadError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError}
        </p>
      ) : (
        <ConnectionCard connection={connection} />
      )}

      {!loading && !loadError && (
        <ConnectionForm connection={connection} onSaved={(next) => setConnection(next)} />
      )}
    </div>
  );
}

function ConnectionCard({ connection }: { connection: WhatsappConnection | null }) {
  if (!connection) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={PhoneOutgoing}
            title="Not connected yet"
            description="This account has no WhatsApp number on file. Add one below to start sending."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Current connection</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <Field label="Phone number ID" value={connection.phoneNumberId} mono />
        <Field label="WABA ID" value={connection.wabaId} mono />
        <Field label="Display name" value={connection.displayName ?? "—"} />
        <Field label="Verified name" value={connection.verifiedName ?? "—"} />
        <Field label="Quality rating" value={connection.qualityRating ?? "—"} />
        <div>
          <p className="text-xs font-medium text-muted-foreground">Registration</p>
          <Badge variant={REGISTRATION_STATE_VARIANT[connection.registrationState]} className="mt-1">
            {REGISTRATION_STATE_LABEL[connection.registrationState]}
          </Badge>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Access token</p>
          <Badge variant={connection.hasAccessToken ? "success" : "warning"} className="mt-1">
            {connection.hasAccessToken ? "On file" : "Not set"}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={mono ? "font-mono text-sm" : "text-sm"}>{value}</p>
    </div>
  );
}

function ConnectionForm({
  connection,
  onSaved,
}: {
  connection: WhatsappConnection | null;
  onSaved: (next: WhatsappConnection) => void;
}) {
  const [fields, setFields] = useState<WhatsappConnectionFormFields>({
    wabaId: "",
    phoneNumberId: "",
    accessToken: "",
  });
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const hasExisting = connection !== null;
  const valid = isConnectionFormValid(fields);

  function handleFieldChange<K extends keyof WhatsappConnectionFormFields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    setSavedNotice(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;

    // Saving replaces a live credential — the first submit on an existing
    // connection only surfaces the confirmation, it does not save.
    if (requiresReplaceConfirmation(hasExisting) && !confirming) {
      setConfirming(true);
      return;
    }

    setSubmitting(true);
    setError(null);
    let status = 0;
    try {
      const res = await fetch("/api/whatsapp/connection", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fields),
      });
      status = res.status;
      const body = (await res.json().catch(() => null)) as SaveWhatsappConnectionResponse | null;
      if (!body || !body.ok) {
        setError(selectSaveErrorMessage(status, body && !body.ok ? body : null));
        // Keep the form's state on failure (including a 403) — nothing here
        // clears `fields`, so the operator doesn't retype three values
        // because they lacked a permission they may not have known about.
        return;
      }
      // The token is write-only: it is never in the response, and it must
      // not linger in state after a successful save either.
      setFields({ wabaId: "", phoneNumberId: "", accessToken: "" });
      setConfirming(false);
      setSavedNotice(true);
      onSaved(body.connection);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{hasExisting ? "Replace connection" : "Connect a number"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="waba-id">WABA ID</Label>
              <Input
                id="waba-id"
                value={fields.wabaId}
                onChange={(e) => handleFieldChange("wabaId", e.target.value)}
                placeholder="e.g. 123456789012345"
                className="mt-1"
                required
              />
            </div>
            <div>
              <Label htmlFor="phone-number-id">Phone number ID</Label>
              <Input
                id="phone-number-id"
                value={fields.phoneNumberId}
                onChange={(e) => handleFieldChange("phoneNumberId", e.target.value)}
                placeholder="e.g. 109876543210987"
                className="mt-1"
                required
              />
            </div>
          </div>

          <div>
            <Label htmlFor="access-token">Access token</Label>
            <Input
              id="access-token"
              // Write-only: never `value` from server state, never prefilled,
              // password-masked so it isn't shoulder-read, and `autoComplete`
              // off so the browser never offers to fill or save it.
              type="password"
              autoComplete="off"
              value={fields.accessToken}
              onChange={(e) => handleFieldChange("accessToken", e.target.value)}
              placeholder={hasExisting ? "Enter a new token to replace the one on file" : "Meta system-user token"}
              className="mt-1"
              required
            />
          </div>

          {confirming && (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
              <p>{REPLACE_CONNECTION_WARNING}</p>
              <div className="flex gap-2">
                <Button type="submit" variant="destructive" size="sm" disabled={submitting}>
                  {submitting && <Loader2 className="size-3.5 animate-spin" />}
                  Yes, replace it
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirming(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {error && (
            <div className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <p>{error.message}</p>
              {error.hint && <p className="text-xs opacity-80">{error.hint}</p>}
            </div>
          )}

          {savedNotice && (
            <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
              Connection saved.
            </p>
          )}

          {!confirming && (
            <Button type="submit" disabled={!valid || submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {hasExisting ? "Save & replace" : "Connect"}
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
