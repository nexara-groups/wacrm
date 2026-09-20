import type { TenantContext } from "../context";
import type { Role } from "../rbac";
import type { UserId } from "../../shared/types";

/**
 * Repository Layer — Profile data access contract.
 *
 * Provider-independent: no SQL, no Supabase, no SDK types. Implementations live
 * in `src/infrastructure`. Business services depend on this interface only.
 */

/** Domain entity for a profile row. Snake_case columns are mapped away here. */
export interface ProfileRecord {
  readonly userId: UserId;
  readonly tenantId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly role: Role;
  readonly createdAt: string;
}

export interface ProfileRepository {
  /** Find a profile by user within a tenant, or null if none exists. */
  findByUser(tenant: TenantContext, userId: UserId): Promise<ProfileRecord | null>;

  /**
   * Update a user's display name within a tenant. A null `displayName` leaves
   * the existing value unchanged (preserves prior behavior). Returns the
   * updated record, or null if the profile does not exist.
   */
  updateDisplayName(
    tenant: TenantContext,
    userId: UserId,
    displayName: string | null,
  ): Promise<ProfileRecord | null>;
}
