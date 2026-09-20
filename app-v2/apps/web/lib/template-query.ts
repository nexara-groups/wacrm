/**
 * Builds the `/api/templates` query string from the table's filter state.
 * Pulled out of `templates-table.tsx` so the URLSearchParams-building
 * decisions (trim-and-omit-when-empty, "All statuses"/"All categories"
 * meaning "omit the param") have a plain `.ts` test next to them — see
 * `apps/web/AGENTS.md`'s testing note.
 *
 * This is what "drive filters through the URL" (the build brief) means in
 * practice: the client never re-filters `Template[]` itself, it only ever
 * changes which query string it asks `listTemplatesQuerySchema` to honour.
 */
import type { TemplateApprovalStatus, TemplateCategory } from "@packages/contracts/src/common/vocab";

export interface TemplateListFilters {
  readonly search: string;
  readonly status: TemplateApprovalStatus | "";
  readonly category: TemplateCategory | "";
  readonly page: number;
  readonly pageSize: number;
}

export function buildTemplatesQuery(filters: TemplateListFilters): string {
  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
  });
  const search = filters.search.trim();
  if (search.length > 0) params.set("search", search);
  if (filters.status) params.set("status", filters.status);
  if (filters.category) params.set("category", filters.category);
  return params.toString();
}
