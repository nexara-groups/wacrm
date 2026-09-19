/**
 * Cross-cutting domain primitives shared by every layer. These are pure types
 * with no provider coupling.
 */

/** Opaque identifier types for readability. */
export type UserId = string;
export type TenantId = string;

// NOTE: TenantContext now lives in `src/core/context` (alongside RequestContext)
// so that all request-scoped context is defined in one place.

/** Minimal authenticated principal shared across auth + rbac layers. */
export interface Principal {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly email: string;
}
