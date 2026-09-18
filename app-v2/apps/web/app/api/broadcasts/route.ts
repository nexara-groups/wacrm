/**
 * `/api/broadcasts` — list (status/search + pagination) and create.
 *
 * Same discipline as `/api/contacts`: every request is validated against
 * the zod schemas in `@packages/contracts/src/broadcasts` before touching a
 * repository, and every failure goes out through the shared error
 * envelope.
 *
 * GAP: `BroadcastRepositoryPort.listForAccount` (modules/broadcasts/
 * application/ports.ts) only exposes cursor pagination with no status/
 * search filter and no total count — it was built for "page through
 * everything", not "give me page 2 of broadcasts named X". The wire
 * contract (`listBroadcastsQuerySchema`/`listBroadcastsResponseSchema`)
 * wants page/pageSize + a total + status/search filtering. Rather than add
 * a port method or touch SQL (forbidden), this route walks every cursor
 * page and does the filtering/pagination here. Fine at this slice's scale
 * (an account's own broadcasts, never the thousands-of-rows scale
 * recipients can reach) but a real port gap for an account with many
 * broadcasts.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  createBroadcastRequestSchema,
  listBroadcastsQuerySchema,
} from "@packages/contracts/src/broadcasts";
import { paginationRange } from "@shared/pagination";
import type { AccountId, UserId } from "@packages/domain/src/ids";
import type { BroadcastRecord } from "@modules/broadcasts/application/ports";
import { getContainer } from "@/lib/container";
import { toBroadcastDTO } from "@/lib/broadcast-dto";
import {
  fail,
  internalError,
  isZodError,
  ok,
  parseOrThrow,
  validationError,
} from "@/lib/api-response";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(listBroadcastsQuerySchema, {
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      search: searchParams.get("search") ?? undefined,
    });

    const { repositories, tenant } = await getContainer();
    const accountId = tenant.tenantId as AccountId;

    const all: BroadcastRecord[] = [];
    let cursor: string | null = null;
    do {
      const page = await repositories.broadcasts.listForAccount(accountId, cursor, 200);
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);

    const search = query.search?.trim().toLowerCase();
    const filtered = all.filter((broadcast) => {
      if (query.status && broadcast.status !== query.status) return false;
      if (search && !broadcast.name.toLowerCase().includes(search)) return false;
      return true;
    });
    filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const total = filtered.length;
    const start = (query.page - 1) * query.pageSize;
    const pageItems = filtered.slice(start, start + query.pageSize);
    const range = paginationRange(total, query.page, query.pageSize, pageItems.length);

    return ok({
      items: pageItems.map(toBroadcastDTO),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = parseOrThrow(createBroadcastRequestSchema, await request.json());

    const { repositories, tenant, ownerUserId } = await getContainer();
    const accountId = tenant.tenantId as AccountId;

    const template = await repositories.messageTemplates.findById(accountId, body.templateId);
    if (template === null) {
      return fail(
        {
          code: "not_found",
          laymanMessage: "That template couldn't be found.",
          fieldErrors: { templateId: ["No template with this id exists for this account."] },
        },
        404,
      );
    }

    // `audienceFilter` is accepted here per contract (create + preview
    // share the same request shape, §4b) but has no persisted effect at
    // creation: `NewBroadcastInput` carries no audience field, and this
    // slice has no "start broadcast" endpoint that would actually build
    // and enqueue an audience — see preview-audience/route.ts for where
    // the filter is really applied. Calling `recordAudience` here, before
    // any recipient rows exist, would break the "preview count === what
    // was enqueued" invariant `toAudiencePreviewDTO` enforces, so
    // `totalRecipients` intentionally stays 0 until a real send starts.
    const created = await repositories.broadcasts.create({
      accountId,
      name: body.name,
      templateId: body.templateId,
      createdBy: ownerUserId as UserId,
      scheduledAt: body.scheduledAt ?? null,
    });

    let final: BroadcastRecord = created;
    if (body.scheduledAt) {
      await repositories.broadcasts.updateStatus(accountId, created.id, "scheduled");
      const refetched = await repositories.broadcasts.getById(accountId, created.id);
      if (refetched) final = refetched;
    }

    return ok({ broadcast: toBroadcastDTO(final) }, { status: 201 });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
