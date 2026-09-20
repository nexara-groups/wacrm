/**
 * `/api/contacts` — list (search + pagination) and create.
 *
 * Every request is validated against the zod schemas in
 * `@packages/contracts/src/contacts` before touching a repository; nothing
 * here hand-rolls validation, and no repository call happens with unchecked
 * input. Every failure returns the shared error envelope, never a raw
 * exception.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  createContactRequestSchema,
  listContactsQuerySchema,
} from "@packages/contracts/src/contacts";
import { parsePhoneNumber } from "@packages/domain";
import { paginationRange } from "@shared/pagination";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
import { toContactDTO } from "@/lib/contact-dto";
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
    const query = parseOrThrow(listContactsQuerySchema, {
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
      search: searchParams.get("search") ?? undefined,
      consentState: searchParams.get("consentState") ?? undefined,
      deliverabilityState: searchParams.get("deliverabilityState") ?? undefined,
    });

    const { repositories, tenant } = await getContainer();
    const result = await repositories.contacts.search(
      tenant,
      {
        ...(query.search !== undefined ? { query: query.search } : {}),
        ...(query.consentState !== undefined ? { consentState: query.consentState } : {}),
        ...(query.deliverabilityState !== undefined
          ? { deliverabilityState: query.deliverabilityState }
          : {}),
      },
      { page: query.page, pageSize: query.pageSize },
    );

    const range = paginationRange(result.total, query.page, query.pageSize, result.items.length);

    return ok({
      items: result.items.map(toContactDTO),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: result.total,
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
    const authorized = await authorizeAction("contacts:write");
    if (!authorized.ok) return authorized.response;

    const body = parseOrThrow(createContactRequestSchema, await request.json());

    let phoneNumber: string;
    try {
      phoneNumber = parsePhoneNumber(body.phoneNumber, body.defaultCountry);
    } catch (error) {
      return fail(
        {
          code: "invalid_phone_number",
          laymanMessage: "That doesn't look like a valid phone number.",
          fieldErrors: {
            phoneNumber: [error instanceof Error ? error.message : String(error)],
          },
        },
        400,
      );
    }

    const { repositories, tenant } = await getContainer();
    const existing = await repositories.contacts.findByPhone(tenant, phoneNumber as never);
    if (existing !== null) {
      return fail(
        {
          code: "duplicate_phone_number",
          laymanMessage: "A contact with this phone number already exists.",
          fieldErrors: { phoneNumber: ["Already in use by another contact."] },
        },
        409,
      );
    }

    const created = await repositories.contacts.create(tenant, {
      phoneNumber: phoneNumber as never,
      displayName: body.displayName ?? null,
      email: body.email ?? null,
      company: null,
    });

    return ok({ contact: toContactDTO(created) }, { status: 201 });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
