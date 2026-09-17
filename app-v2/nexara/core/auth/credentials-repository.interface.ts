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
