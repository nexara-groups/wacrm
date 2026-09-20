"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, Search, Users, ChevronLeft, ChevronRight } from "lucide-react";
import type { Contact, ListContactsResponse } from "@packages/contracts/src/contacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConsentBadge, DeliverabilityBadge } from "@/components/contacts/status-badges";

const PAGE_SIZE = 20;

export interface ContactsPage {
  readonly items: readonly Contact[];
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

async function fetchContacts(search: string, page: number): Promise<ContactsPage> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (search.trim().length > 0) params.set("search", search.trim());

  const res = await fetch(`/api/contacts?${params.toString()}`);
  const body = (await res.json()) as ListContactsResponse;
  if (!body.ok) throw new Error(body.error.laymanMessage);
  return body;
}

export function ContactsTable({ initial }: { initial: ContactsPage }) {
  const [data, setData] = useState<ContactsPage>(initial);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Guards against an earlier, slower request resolving after a newer one
  // and clobbering fresher results.
  const requestSeq = useRef(0);

  const reload = useCallback((nextSearch: string, nextPage: number) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    fetchContacts(nextSearch, nextPage)
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

  // Debounced search — reload 300ms after the last keystroke.
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
      reload(search, 1);
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function goToPage(next: number) {
    setPage(next);
    reload(search, next);
  }

  const contacts = data.items;
  const { pagination } = data;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Contacts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {pagination.total > 0
              ? `${pagination.total} contact${pagination.total === 1 ? "" : "s"}`
              : "No contacts yet"}
          </p>
        </div>
        <Button onClick={() => setAddOpen((v) => !v)}>
          <Plus className="size-4" />
          Add contact
        </Button>
      </div>

      {addOpen && (
        <AddContactForm
          onCreated={() => {
            setAddOpen(false);
            reload(search, page);
          }}
          onCancel={() => setAddOpen(false)}
        />
      )}

      <div className="relative w-full max-w-sm">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, phone, or email…"
          className="pl-8"
        />
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
              <TableHead>Phone</TableHead>
              <TableHead className="hidden md:table-cell">Email</TableHead>
              <TableHead>Consent</TableHead>
              <TableHead>Deliverability</TableHead>
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
            ) : contacts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {search.trim().length > 0 ? "No contacts match your search." : "No contacts yet."}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell className="font-medium">
                    {contact.displayName || (
                      <span className="text-muted-foreground italic">Unnamed</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {contact.phoneNumber}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                    {contact.email || <span>-</span>}
                  </TableCell>
                  <TableCell>
                    <ConsentBadge state={contact.consentState} />
                  </TableCell>
                  <TableCell>
                    <DeliverabilityBadge
                      state={contact.deliverabilityState}
                      reasonCode={contact.suppressedReasonCode}
                    />
                  </TableCell>
                </TableRow>
              ))
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

function AddContactForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFieldErrors({});
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phoneNumber,
          displayName: displayName || undefined,
          email: email || undefined,
        }),
      });
      const body = (await res.json()) as
        | { ok: true }
        | { ok: false; error: { laymanMessage: string; fieldErrors?: Record<string, string[]> } };
      if (!body.ok) {
        setFieldErrors(body.error.fieldErrors ?? { _root: [body.error.laymanMessage] });
        return;
      }
      onCreated();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-4"
    >
      <div className="sm:col-span-1">
        <Input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Name"
        />
      </div>
      <div className="sm:col-span-1">
        <Input
          value={phoneNumber}
          onChange={(e) => setPhoneNumber(e.target.value)}
          placeholder="Phone number"
          required
        />
        {fieldErrors.phoneNumber && (
          <p className="mt-1 text-xs text-destructive">{fieldErrors.phoneNumber[0]}</p>
        )}
      </div>
      <div className="sm:col-span-1">
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          type="email"
        />
      </div>
      <div className="flex items-center gap-2 sm:col-span-1">
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {fieldErrors._root && (
        <p className="text-xs text-destructive sm:col-span-4">{fieldErrors._root[0]}</p>
      )}
    </form>
  );
}
