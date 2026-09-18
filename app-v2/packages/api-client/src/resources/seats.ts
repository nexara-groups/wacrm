/** Seats — usage (used/limit/remaining + pending invitations + a pre-rendered status line). */
import type { GetSeatUsageRequest, GetSeatUsageResponse } from "@packages/contracts/src/index";
import { getSeatUsageResponseSchema } from "@packages/contracts/src/index";
import { apiRequest, type ApiClientContext, type SuccessOf } from "../http";
import type { ApiClientError } from "../errors";
import type { Result } from "../result";

export interface SeatsResource {
  getUsage(request: GetSeatUsageRequest): Promise<Result<SuccessOf<GetSeatUsageResponse>, ApiClientError>>;
}

export function createSeatsResource(ctx: ApiClientContext): SeatsResource {
  return {
    getUsage: (request) =>
      apiRequest(ctx, { method: "GET", path: "/seats.usage", query: request }, getSeatUsageResponseSchema),
  };
}
