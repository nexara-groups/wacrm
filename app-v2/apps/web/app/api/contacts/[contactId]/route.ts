/**
 * `/api/contacts/[contactId]` — get one, update.
 *
 * Same discipline as the collection route: zod-validated in, error-envelope
 * out, repository-only persistence.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  getContactRequestSchema,
  updateContactRequestSchema,
} from "@packages/contracts/src/contacts";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
import { toContactDTO } from "@/lib/contact-dto";
import {
  fail,
  internalError,
  isZodError,
  notFoundError,
  ok,
  parseOrThrow,
  validationError,
} from "@/lib/api-response";

interface RouteContext {
  params: Promise<{ contactId: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { contactId: rawContactId } = await context.params;
    const { contactId } = parseOrThrow(getContactRequestSchema, { contactId: rawContactId });

    const { repositories, tenant } = await getContainer();
    const contact = await repositories.contacts.findById(tenant, contactId);

    return ok({ contact: contact === null ? null : toContactDTO(contact) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const authorized = await authorizeAction("contacts:write");
    if (!authorized.ok) return authorized.response;

    const { contactId: rawContactId } = await context.params;
    const body = parseOrThrow(updateContactRequestSchema, await request.json());

    if (body.contactId !== rawContactId) {
      return fail(
        {
          code: "validation_error",
          laymanMessage: "That request wasn't quite right — check the highlighted fields.",
          fieldErrors: { contactId: ["Does not match the resource in the URL."] },
        },
        400,
      );
    }

    const { repositories, tenant } = await getContainer();
    const patch = {
      ...("displayName" in body ? { displayName: body.displayName ?? null } : {}),
      ...("email" in body ? { email: body.email ?? null } : {}),
    };
    const updated = await repositories.contacts.updateProfile(tenant, body.contactId, patch);

    if (updated === null) return notFoundError("contact");
    return ok({ contact: toContactDTO(updated) });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
