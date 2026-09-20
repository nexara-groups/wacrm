/**
 * `/api/broadcasts` — list (status/search + pagination) and create.
 *
 * Same discipline as `/api/contacts`: every request is validated against
 * the zod schemas in `@packages/contracts/src/broadcasts` before touching a
 * repository, and every failure goes out through the shared error
 * envelope.
 *
 * `GET` calls `BroadcastRepositoryPort.search` (modules/broadcasts/
 * application/ports.ts) directly: status/search filtering and the total
 * come from SQL (`COUNT(*)` + `LIMIT`/`OFFSET`), so this is a single bounded
 * read — never a walk of `listForAccount`'s cursor to the end. That method
 * stays available for callers that want plain cursor pagination over every
 * broadcast (recipient fan-out tooling, etc.).
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  createBroadcastRequestSchema,
  listBroadcastsQuerySchema,
} from "@packages/contracts/src/broadcasts";
import { paginationRange } from "@shared/pagination";
import type { AccountId, UserId } from "@packages/domain/src/ids";
import type { BroadcastRecord, BroadcastSearchFilter } from "@modules/broadcasts/application/ports";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
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

    const filter: BroadcastSearchFilter = {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
    };

    const { items, total } = await repositories.broadcasts.search(accountId, filter, {
      page: query.page,
      pageSize: query.pageSize,
    });

    const range = paginationRange(total, query.page, query.pageSize, items.length);

    return ok({
      items: items.map(toBroadcastDTO),
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
    const authorized = await authorizeAction("broadcasts:write");
    if (!authorized.ok) return authorized.response;

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
