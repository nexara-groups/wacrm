import type { Role } from "@nexara/core/rbac";
import type { TenantId, UserId } from "@shared/types";
import type {
  EmailTokenPort,
  EmailTokenRecord,
  EmailTokenType,
  NewEmailTokenRecord,
} from "../domain/email-tokens";
import type { DeviceSession } from "../domain/extended-auth-provider.interface";
import type {
  NewRefreshTokenRecord,
  RefreshTokenPort,
  RefreshTokenRecord,
} from "../domain/refresh-token-rotation";

/**
 * Identity module — application-layer repository ports.
 *
 * Interfaces only: no SQL, no vendor imports, no `fetch`. Persistence
 * (D1/SQLite/Postgres/whatever) is owned by another track and implements
 * these shapes; this module only depends on the shapes.
 *
 * Table mapping (see AUTH_EXTENSION.md):
 *  users                -> UserRepositoryPort
 *  sessions              -> SessionRepositoryPort
 *  refresh_tokens        -> RefreshTokenRepositoryPort (= domain RefreshTokenPort)
 *  email_tokens          -> EmailTokenRepositoryPort (= domain EmailTokenPort)
 *  device_installations  -> DeviceInstallationRepositoryPort
 */

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export interface UserRecord {
  readonly id: UserId;
  readonly accountId: TenantId;
  readonly email: string;
  /** Hash only — see domain/token-hashing.ts. Never the raw password. */
  readonly passwordHash: string;
  readonly emailVerifiedAt: string | null;
  readonly role: Role;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewUserRecord {
  readonly accountId: TenantId;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: Role;
  readonly emailVerifiedAt: string | null;
}

export interface UserRepositoryPort {
  findById(id: UserId): Promise<UserRecord | null>;
  findByEmail(accountId: TenantId, email: string): Promise<UserRecord | null>;
  create(input: NewUserRecord): Promise<UserRecord>;
  updatePasswordHash(id: UserId, passwordHash: string): Promise<void>;
  markEmailVerified(id: UserId, verifiedAt: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export interface SessionRecord {
  readonly id: string;
  readonly userId: UserId;
  readonly deviceId: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface NewSessionRecord {
  readonly userId: UserId;
  readonly deviceId: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
}

export interface SessionRepositoryPort {
  create(input: NewSessionRecord): Promise<SessionRecord>;
  findById(id: string): Promise<SessionRecord | null>;
  touch(id: string, lastSeenAt: string): Promise<void>;
  revoke(id: string, revokedAt: string): Promise<void>;
  revokeAllForUser(userId: UserId, revokedAt: string): Promise<void>;
  listForUser(userId: UserId): Promise<readonly SessionRecord[]>;
}

/** `DeviceSession` (the shape returned to callers by `listSessions`) is defined once, in the domain layer. */
export type { DeviceSession };

// ---------------------------------------------------------------------------
// refresh_tokens — the port shape is owned by the domain rotation logic
// ---------------------------------------------------------------------------

export type RefreshTokenRepositoryPort = RefreshTokenPort;
export type { NewRefreshTokenRecord, RefreshTokenRecord };

// ---------------------------------------------------------------------------
// email_tokens — the port shape is owned by the domain email-token logic
// ---------------------------------------------------------------------------

export type EmailTokenRepositoryPort = EmailTokenPort;
export type { EmailTokenRecord, EmailTokenType, NewEmailTokenRecord };

// ---------------------------------------------------------------------------
// device_installations
// ---------------------------------------------------------------------------

export interface DeviceInstallationRecord {
  readonly id: string;
  readonly userId: UserId;
  readonly accountId: TenantId;
  readonly platform: string;
  readonly pushToken: string | null;
  readonly deviceId: string;
  readonly appVersion: string | null;
  readonly lastSeenAt: string;
  readonly enabled: boolean;
}

export interface NewDeviceInstallationRecord {
  readonly userId: UserId;
  readonly accountId: TenantId;
  readonly platform: string;
  readonly pushToken: string | null;
  readonly deviceId: string;
  readonly appVersion: string | null;
  readonly enabled: boolean;
}

export interface DeviceInstallationRepositoryPort {
  upsert(input: NewDeviceInstallationRecord): Promise<DeviceInstallationRecord>;
  listForUser(userId: UserId): Promise<readonly DeviceInstallationRecord[]>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  touch(id: string, lastSeenAt: string): Promise<void>;
}
