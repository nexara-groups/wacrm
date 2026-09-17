import type { TenantContext } from "../context";
import type { Role } from "../rbac";
import type { UserId } from "../../shared/types";

/**
 * Repository Layer — User (identity) data access contract.
 *
 * Provider-independent. Represents the tenant-scoped user store the foundation
 * exposes for identity lookups; business modules added later read users through
 * this interface rather than touching the database directly.
 */

export interface UserRecord {
  readonly userId: UserId;
  readonly tenantId: string;
  readonly email: string;
  readonly role: Role;
  readonly createdAt: string;
}

export interface UserRepository {
  /** Find a user by id within a tenant, or null. */
  findById(tenant: TenantContext, userId: UserId): Promise<UserRecord | null>;

  /** Find a user by email within a tenant, or null. */
  findByEmail(tenant: TenantContext, email: string): Promise<UserRecord | null>;
}
