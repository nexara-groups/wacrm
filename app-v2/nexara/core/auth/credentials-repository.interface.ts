import type { TenantContext } from "../context";
import type { Role } from "../rbac";
import type { TenantId, UserId } from "../../shared/types";

/** Auth-only record. Password hashes never flow through a profile or user port. */
export interface Credential {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: Role;
  readonly sessionVersion: number;
  readonly verifiedAt: string | null;
}

export interface NewCredentialInput {
  readonly userId: UserId;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: Role;
  readonly verifiedAt: string | null;
}

export interface NewPasswordResetInput {
  readonly tokenHash: string;
  readonly userId: UserId;
  readonly email: string;
  readonly expiresAt: string;
}

export interface NewEmailVerificationInput {
  readonly tokenHash: string;
  readonly userId: UserId;
  readonly email: string;
  readonly expiresAt: string;
}

export interface CredentialsRepository {
  findByEmail(tenant: TenantContext, email: string): Promise<Credential | null>;

  /**
   * Find a credential by email ACROSS ALL TENANTS, returning the tenant it
   * belongs to.
   *
   * Login's first question is "who is this?", and the answer includes which
   * tenant — a login request carries an email and a password and nothing
   * else. Every other method here takes a tenant as an input; this is the one
   * that PRODUCES one, which is why it is the only one without a
   * `TenantContext` parameter.
   *
   * Unambiguous because `credentials.email` is globally unique
   * (0013_global_email_uniqueness.sql), so this returns at most one row.
   *
   * Callers must use the `tenantId` on the returned credential for
   * everything downstream, and must never accept a tenant supplied by the
   * request. That is what makes the tenant derived rather than asserted.
   */
  findByEmailAnyTenant(email: string): Promise<Credential | null>;
  findByUserId(tenant: TenantContext, userId: UserId): Promise<Credential | null>;
  create(tenant: TenantContext, input: NewCredentialInput): Promise<Credential>;
  createPasswordReset(tenant: TenantContext, input: NewPasswordResetInput): Promise<void>;
  findUsablePasswordReset(tenant: TenantContext, tokenHash: string): Promise<{ userId: UserId; email: string } | null>;
  redeemPasswordReset(tenant: TenantContext, tokenHash: string, userId: UserId, passwordHash: string): Promise<boolean>;
  createEmailVerification(tenant: TenantContext, input: NewEmailVerificationInput): Promise<void>;
  findUsableEmailVerification(tenant: TenantContext, tokenHash: string): Promise<{ userId: UserId; email: string } | null>;
  redeemEmailVerification(tenant: TenantContext, tokenHash: string, userId: UserId): Promise<boolean>;
  revokeSessions(tenant: TenantContext, userId: UserId): Promise<void>;
}
