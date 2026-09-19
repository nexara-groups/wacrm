import { AppError } from "../../shared/errors";
import type { TenantId } from "../../shared/types";

/**
 * TenantContext — the tenant a unit of work is scoped to.
 *
 * Threaded through repositories and services so every data access and
 * permission check is explicitly tenant-scoped. Provider-independent.
 */
export interface TenantContext {
  readonly tenantId: TenantId;
}

export function createTenantContext(tenantId: TenantId): TenantContext {
  if (!tenantId || tenantId.trim().length === 0) {
    throw AppError.validation("tenantId is required to build a TenantContext");
  }
  return { tenantId };
}
