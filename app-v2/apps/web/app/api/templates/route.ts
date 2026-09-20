/**
 * `GET /api/templates` — list the tenant's mirrored WhatsApp templates, for
 * the inbox composer's template picker (and anywhere else that needs the
 * approved set).
 *
 * FREE-TIER NOTE, stated honestly: `MessageTemplateRepositoryPort` exposes
 * only `listByAccount(accountId)` — no paginated/filtered method — so this
 * route reads every template row for the account and does the `status`
 * filter and the page slice in memory. That is acceptable ONLY because a
 * WABA's template count is bounded by Meta's own per-account template limit
 * (in the low hundreds), not by traffic — unlike `contacts` or `messages`,
 * this table cannot grow with usage, so "read it all" stays a small,
 * constant-ish read no matter how busy the account gets. `pageSize` is still
 * capped below regardless, and this reasoning does NOT license the same
 * pattern for a table that scales with usage.
 *
 * No new port method is added and no SQL is added here — that would need a
 * repository change, out of scope for wiring up a UI that already has a
 * `listByAccount` to work with.
 */
import { NextResponse, type NextRequest } from "next/server";
import { listTemplatesQuerySchema } from "@packages/contracts/src/templates";
import { AccountId } from "@packages/domain/src/ids";
import { paginationRange } from "@shared/pagination";
import { getContainer } from "@/lib/container";
import { toTemplateDTO } from "@/lib/template-dto";
import { internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(listTemplatesQuerySchema, {
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
      category: searchParams.get("category") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      search: searchParams.get("search") ?? undefined,
    });

    const { repositories, tenant } = await getContainer();
    const accountId = AccountId(tenant.tenantId);
    const all = await repositories.messageTemplates.listByAccount(accountId);

    const search = query.search?.trim().toLowerCase();
    const filtered = all.filter((template) => {
      if (query.category !== undefined && template.category !== query.category) return false;
      if (query.status !== undefined && template.status !== query.status) return false;
      if (search !== undefined && !template.name.toLowerCase().includes(search)) return false;
      return true;
    });

    const start = (query.page - 1) * query.pageSize;
    const page = filtered.slice(start, start + query.pageSize);
    const range = paginationRange(filtered.length, query.page, query.pageSize, page.length);

    return ok({
      items: page.map(toTemplateDTO),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: filtered.length,
        totalPages: range.totalPages,
        from: range.from,
        to: range.to,
        hasPrevious: range.hasPrevious,
        hasNext: range.hasNext,
      },
    });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
