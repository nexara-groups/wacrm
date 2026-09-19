/**
 * `GET /api/seats` — seat usage for the current account (SEAT_LIMITS.md §2),
 * for the `/settings/team` header. Read-only: no request body/query to
 * validate beyond authentication (`getContainer()` throws
 * `AppError.unauthenticated` with no session, mapped by `internalError`).
 *
 * The numbers come straight from `SeatRepository` (read fresh every call,
 * per §2 "changing the platform default moves every inheriting account
 * immediately") and are assembled by `lib/seat-dto.ts#buildSeatUsageDTO`,
 * which reuses the same domain functions `SeatService` itself calls
 * (`resolveSeatLimit`, `countSeats`, `computeOverSeatLimitStatus`,
 * `SEAT_MESSAGES`) rather than reimplementing the cap/status logic here.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getContainer } from "@/lib/container";
import { buildSeatUsageDTO } from "@/lib/seat-dto";
import { internalError, isZodError, ok, validationError } from "@/lib/api-response";

export async function GET(_request: NextRequest): Promise<NextResponse> {
  try {
    const { repositories, tenant } = await getContainer();

    const [config, members, invitations] = await Promise.all([
      repositories.seats.getSeatLimitConfig(tenant),
      repositories.seats.listMembers(tenant),
      repositories.seats.listInvitations(tenant),
    ]);

    const { usage, limitSource } = buildSeatUsageDTO(
      tenant.tenantId,
      config,
      members,
      invitations,
      new Date(),
    );

    return ok({ usage, limitSource });
  } catch (error) {
    if (isZodError(error)) return validationError(error);
    return internalError(error);
  }
}
