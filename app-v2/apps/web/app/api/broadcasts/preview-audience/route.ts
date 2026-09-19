/**
 * `POST /api/broadcasts/preview-audience` — the centrepiece screen per
 * META_ERROR_TAXONOMY.md §4b: total audience, how many will actually be
 * sent to, and the skipped contacts GROUPED BY REASON in plain language.
 *
 * `buildAudience` (modules/broadcasts/domain/audience.ts) is the pure
 * function that applies the consent/deliverability filter and groups the
 * rejects; `toAudiencePreviewDTO` (lib/broadcast-dto.ts) maps its result
 * onto the wire shape and is what makes "preview count === what would be
 * enqueued" hold by construction. Both are used as-is here, unmodified.
 *
 * GAP: `AudienceSource.listCandidates` (modules/broadcasts/application/
 * ports.ts) and `BroadcastService.previewAudience` take NO filter
 * parameter at all — they page through every contact in the account. The
 * wire contract's `audienceFilter` (tags/search/explicit contactIds) is
 * therefore applied here directly against `ContactRepository.search` /
 * `.findById` (a real repository this module already has, not a new port)
 * before handing the resulting candidate list to `buildAudience`. This is
 * necessary rather than optional: without it, every preview would just be
 * "the whole account," which is not what an operator narrowing by tag or
 * hand-picking recipients is asking for. The same gap would bite a future
 * "start broadcast" endpoint built directly on `BroadcastService.
 * startBroadcast`, which enqueues from the SAME unfiltered
 * `previewAudience` call — worth flagging to the team, not something this
 * route can fix by itself (no port method may be added here).
 */
import { NextResponse, type NextRequest } from "next/server";
import { previewAudienceRequestSchema, type AudienceFilter } from "@packages/contracts/src/broadcasts";
import type { TenantContext } from "@nexara/core/context";
import type { ContactRecord, ContactSearchFilter } from "@modules/contacts/application/ports";
import { canonicalTagKey } from "@modules/contacts/domain/tags";
import { buildAudience } from "@modules/broadcasts/domain/audience";
import { getContainer } from "@/lib/container";
import { toAudiencePreviewDTO } from "@/lib/broadcast-dto";
import { internalError, isZodError, ok, parseOrThrow, validationError } from "@/lib/api-response";

const CANDIDATE_PAGE_SIZE = 200;

async function collectCandidates(
  repositories: Awaited<ReturnType<typeof getContainer>>["repositories"],
  tenant: TenantContext,
  filter: AudienceFilter,
): Promise<readonly ContactRecord[]> {
  if (filter.contactIds && filter.contactIds.length > 0) {
    const found = await Promise.all(
      filter.contactIds.map((contactId) => repositories.contacts.findById(tenant, contactId)),
    );
    return found.filter((contact): contact is ContactRecord => contact !== null);
  }

  let tagFilter: ContactSearchFilter["tagFilter"];
  if (filter.tags && filter.tags.length > 0) {
    const allTags = await repositories.contacts.listTags(tenant);
    const wanted = new Set(filter.tags.map(canonicalTagKey));
    const tagIds = allTags.filter((tag) => wanted.has(canonicalTagKey(tag.name))).map((tag) => tag.id);
    // None of the requested tag names exist for this account -> nothing
    // can match; skip the search call rather than sending an empty
    // tagFilter (which `contactMatchesTagFilter` treats as "match
    // everything", the opposite of what's intended here).
    if (tagIds.length === 0) return [];
    tagFilter = { tagIds, mode: "any" };
  }

  const searchFilter: ContactSearchFilter = {
    ...(filter.search ? { query: filter.search } : {}),
    ...(tagFilter ? { tagFilter } : {}),
  };

  const out: ContactRecord[] = [];
  let page = 1;
  for (;;) {
    const result = await repositories.contacts.search(tenant, searchFilter, {
      page,
      pageSize: CANDIDATE_PAGE_SIZE,
    });
    out.push(...result.items);
    if (out.length >= result.total || result.items.length === 0) break;
    page += 1;
  }
  return out;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = parseOrThrow(previewAudienceRequestSchema, await request.json());

    const { repositories, tenant } = await getContainer();

    const candidates = await collectCandidates(repositories, tenant, body.audienceFilter);
    const selection = buildAudience(candidates);

    return ok({ preview: toAudiencePreviewDTO(selection) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
