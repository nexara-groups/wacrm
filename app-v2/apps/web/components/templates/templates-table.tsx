"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Loader2, Search } from "lucide-react";
import type { ListTemplatesResponse, Template } from "@packages/contracts/src/templates";
import type { TemplateApprovalStatus, TemplateCategory } from "@packages/contracts/src/common/vocab";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { TemplateCategoryBadge, TemplateStatusBadge } from "@/components/templates/status-badges";
import { buildTemplatesQuery } from "@/lib/template-query";
import { TEMPLATE_CATEGORY_LABEL, TEMPLATE_STATUS_LABEL } from "@/lib/template-status";

const PAGE_SIZE = 20;

const STATUS_OPTIONS: readonly { value: TemplateApprovalStatus | ""; label: string }[] = [
  { value: "", label: "All statuses" },
  ...(Object.entries(TEMPLATE_STATUS_LABEL) as [TemplateApprovalStatus, string][]).map(([value, label]) => ({
    value,
    label,
  })),
];

const CATEGORY_OPTIONS: readonly { value: TemplateCategory | ""; label: string }[] = [
  { value: "", label: "All categories" },
  ...(Object.entries(TEMPLATE_CATEGORY_LABEL) as [TemplateCategory, string][]).map(([value, label]) => ({
    value,
    label,
  })),
];

export interface TemplatesPage {
  readonly items: readonly Template[];
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

async function fetchTemplates(
  search: string,
  status: TemplateApprovalStatus | "",
  category: TemplateCategory | "",
  page: number,
): Promise<TemplatesPage> {
  const qs = buildTemplatesQuery({ search, status, category, page, pageSize: PAGE_SIZE });
  const res = await fetch(`/api/templates?${qs}`);
  const body = (await res.json()) as ListTemplatesResponse;
  if (!body.ok) throw new Error(body.error.laymanMessage);
  return body;
}

/**
 * Same shape as `ContactsTable`/`BroadcastsTable`: server-rendered first
 * page from `initial`, then this client component drives search/status/
 * category/pagination over `/api/templates` — the server (via
 * `listTemplatesQuerySchema`) stays the one place that filters, this
 * component never re-filters `initial.items` itself.
 */
export function TemplatesTable({ initial }: { initial: TemplatesPage }) {
  const [data, setData] = useState<TemplatesPage>(initial);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TemplateApprovalStatus | "">("");
  const [category, setCategory] = useState<TemplateCategory | "">("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against an earlier, slower request resolving after a newer one
  // and clobbering fresher results — same guard as ContactsTable/BroadcastsTable.
  const requestSeq = useRef(0);

  const reload = useCallback(
    (nextSearch: string, nextStatus: TemplateApprovalStatus | "", nextCategory: TemplateCategory | "", nextPage: number) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      fetchTemplates(nextSearch, nextStatus, nextCategory, nextPage)
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
    },
    [],
  );

  // Debounced search, immediate on status/category — matches BroadcastsTable.
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
      reload(search, status, category, 1);
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, category]);

  function goToPage(next: number) {
    setPage(next);
    reload(search, status, category, next);
  }

  const templates = data.items;
  const { pagination } = data;
  const hasFilters = search.trim().length > 0 || status !== "" || category !== "";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {pagination.total > 0
            ? `${pagination.total} template${pagination.total === 1 ? "" : "s"}`
            : "No templates yet"}
        </p>
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
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value as TemplateApprovalStatus | "")}
          className="sm:w-48"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
        <Select
          value={category}
          onChange={(e) => setCategory(e.target.value as TemplateCategory | "")}
          className="sm:w-48"
        >
          {CATEGORY_OPTIONS.map((opt) => (
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
              <TableHead>Language</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Parameters</TableHead>
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
            ) : templates.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={FileText}
                    title={hasFilters ? "No templates match your filters." : "No templates yet."}
                    description={
                      hasFilters
                        ? undefined
                        : "Templates created in WhatsApp Manager and synced to this account will show up here, along with their Meta approval status."
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              templates.map((template) => (
                <TableRow key={template.id}>
                  <TableCell className="font-medium">{template.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{template.language}</TableCell>
                  <TableCell>
                    <TemplateCategoryBadge category={template.category} />
                  </TableCell>
                  <TableCell>
                    <TemplateStatusBadge status={template.status} />
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {template.variableCount}
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
