import type { AuthUser, Credentials, Session } from "@nexara/core/auth";
import type { EmailProvider } from "@nexara/core/email";
import { isRole, type Permission, type PermissionService } from "@nexara/core/rbac";
import { AppError } from "@shared/errors";
import type { TenantId, UserId } from "@shared/types";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type {
  DeviceSession,
  ExtendedAuthProvider,
  IdentitySession,
} from "../domain/extended-auth-provider.interface";
import { consumeEmailToken, issueEmailToken, type EmailTokenDeps } from "../domain/email-tokens";
import {
  issueInitialRefreshToken,
  rotateRefreshToken,
  type RotationDeps,
} from "../domain/refresh-token-rotation";
import { DUMMY_PASSWORD_HASH, generateToken, hashPassword, hashToken, verifyPassword } from "../domain/token-hashing";
import type {
  DeviceInstallationRecord,
  DeviceInstallationRepositoryPort,
  EmailTokenRepositoryPort,
  NewDeviceInstallationRecord,
  RefreshTokenRepositoryPort,
  SessionRepositoryPort,
  UserRecord,
  UserRepositoryPort,
} from "./ports";

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // short-lived; refresh does the heavy lifting
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface IdentityAccessTokenClaims extends JWTPayload {
  /** Tenant claim, per AUTH_EXTENSION.md ("Tenant claim (account_id) + role in the access token"). */
  readonly account_id: string;
  readonly role: string;
  readonly email: string;
  /** Session id — lets `logout`/`getCurrentUser` check live revocation, not just JWT expiry. */
  readonly sid: string;
}

export interface IdentityServiceConfig {
  /** The single tenant (account) this service instance is scoped to. */
  readonly accountId: TenantId;
  readonly issuer: string;
  readonly audience: string;
  /** HMAC signing secret for access tokens. Must be at least 32 bytes. */
  readonly secret: string;
  readonly accessTokenTtlSeconds?: number;
  readonly sessionTtlMs?: number;
  readonly refreshTokenTtlMs?: number;
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Identity module — orchestrates the extended auth flows over the
 * application ports and the pure domain logic (rotation, hashing,
 * email-tokens).
 *
 * `EmailProvider` is a REQUIRED constructor dependency, not optional. The
 * password-reset, email-verification and invitation flows all send email;
 * making the dependency required means it is impossible, at the type level,
 * to construct an `IdentityService` whose email-sending flows would compile
 * but silently do nothing (or throw) for want of a wired provider. There is
 * no "IdentityService without email" configuration to accidentally ship.
 */
export class IdentityService implements ExtendedAuthProvider {
  readonly name = "identity";
  private readonly secretKey: Uint8Array;

  constructor(
    private readonly config: IdentityServiceConfig,
    private readonly users: UserRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly refreshTokens: RefreshTokenRepositoryPort,
    private readonly emailTokens: EmailTokenRepositoryPort,
    private readonly permissions: PermissionService,
    private readonly emailProvider: EmailProvider,
    private readonly deviceInstallations?: DeviceInstallationRepositoryPort,
  ) {
    this.secretKey = new TextEncoder().encode(config.secret);
    if (this.secretKey.byteLength < 32) {
      throw AppError.validation("Identity signing secret must contain at least 32 bytes");
    }
    // Runtime guard behind the type-level guarantee above: even if a caller
    // reaches this constructor through untyped JS (or `as any`), a missing
    // EmailProvider fails loudly at construction time rather than the first
    // time a reset/verify/invite email silently fails to send.
    if (!this.emailProvider) {
      throw AppError.validation("IdentityService requires an EmailProvider");
    }
  }

  // ---------------------------------------------------------------------
  // login / logout / session introspection (AuthProvider)
  // ---------------------------------------------------------------------

  async login(credentials: Credentials): Promise<IdentitySession> {
    const email = normalizedEmail(credentials.email);
    const record = await this.users.findByEmail(this.config.accountId, email);

    if (!record) {
      // Constant-time-ish: still run a PBKDF2 verify so a lookup miss takes
      // roughly as long as a real mismatch, mitigating email enumeration.
      await verifyPassword(credentials.password, DUMMY_PASSWORD_HASH);
      throw AppError.unauthenticated("Invalid email or password");
    }
    if (!(await verifyPassword(credentials.password, record.passwordHash))) {
      throw AppError.unauthenticated("Invalid email or password");
    }
    if (!record.emailVerifiedAt) {
      throw AppError.forbidden("Verify your email before logging in");
    }

    return this.issueSession(record);
  }

  async logout(accessToken: string): Promise<void> {
    const claims = await this.verifyAccessToken(accessToken);
    if (!claims) return;
    await this.sessions.revoke(claims.sid, new Date().toISOString());
  }

  async getCurrentUser(accessToken: string): Promise<AuthUser | null> {
    const claims = await this.verifyAccessToken(accessToken);
    if (!claims || !claims.sub) return null;

    const session = await this.sessions.findById(claims.sid);
    if (!session || session.revokedAt) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;

    const record = await this.users.findById(claims.sub);
    if (!record) return null;

    return this.toAuthUser(record);
  }

  async getSession(accessToken: string): Promise<Session | null> {
    const user = await this.getCurrentUser(accessToken);
    return user ? { user, accessToken } : null;
  }

  verifyPermission(user: AuthUser, permission: Permission): boolean {
    return this.permissions.can(user.role, permission);
  }

  // ---------------------------------------------------------------------
  // refresh / session management (extended)
  // ---------------------------------------------------------------------

  async refresh(refreshToken: string): Promise<IdentitySession> {
    const result = await rotateRefreshToken(this.rotationDeps(), refreshToken);
    if (!result.ok) throw result.error;

    const { record, rawToken } = result.value;
    const session = await this.sessions.findById(record.sessionId);
    if (!session || session.revokedAt) {
      throw AppError.unauthenticated("Session no longer active");
    }
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      throw AppError.unauthenticated("Session has expired");
    }

    const user = await this.users.findById(session.userId);
    if (!user) throw AppError.unauthenticated("User no longer exists");

    await this.sessions.touch(session.id, new Date().toISOString());

    const { accessToken, expiresAt } = await this.issueAccessToken(user, session.id);
    return { user: this.toAuthUser(user), accessToken, expiresAt, refreshToken: rawToken };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, new Date().toISOString());
  }

  async revokeAllSessions(userId: UserId): Promise<void> {
    await this.sessions.revokeAllForUser(userId, new Date().toISOString());
  }

  async listSessions(userId: UserId): Promise<DeviceSession[]> {
    const records = await this.sessions.listForUser(userId);
    return records.map((session) => ({
      sessionId: session.id,
      userId: session.userId,
      deviceId: session.deviceId,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
    }));
  }

  // ---------------------------------------------------------------------
  // password reset / email verification / invitations (require EmailProvider)
  // ---------------------------------------------------------------------

  async requestPasswordReset(email: string): Promise<void> {
    const record = await this.users.findByEmail(this.config.accountId, normalizedEmail(email));
    // Resolve silently either way — do not let this endpoint reveal whether
    // an email is registered.
    if (!record) return;

    const { rawToken } = await issueEmailToken(this.emailTokenDeps(), record.id, "reset");
    await this.emailProvider.send({
      to: record.email,
      subject: "Reset your password",
      text: `Use this token to reset your password: ${rawToken}`,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const result = await consumeEmailToken(this.emailTokenDeps(), token, "reset");
    if (!result.ok) throw result.error;

    const passwordHash = await hashPassword(newPassword);
    await this.users.updatePasswordHash(result.value.userId, passwordHash);
    // A password reset is a strong signal of compromise recovery — kill any
    // sessions issued under the old password.
    await this.revokeAllSessions(result.value.userId);
  }

  async verifyEmail(token: string): Promise<void> {
    const result = await consumeEmailToken(this.emailTokenDeps(), token, "verify");
    if (!result.ok) throw result.error;
    await this.users.markEmailVerified(result.value.userId, new Date().toISOString());
  }

  async acceptInvitation(token: string, password: string): Promise<IdentitySession> {
    const result = await consumeEmailToken(this.emailTokenDeps(), token, "invite");
    if (!result.ok) throw result.error;

    const record = await this.users.findById(result.value.userId);
    if (!record) throw AppError.notFound("Invited user no longer exists");

    const passwordHash = await hashPassword(password);
    await this.users.updatePasswordHash(record.id, passwordHash);
    await this.users.markEmailVerified(record.id, new Date().toISOString());

    const refreshed = await this.users.findById(record.id);
    return this.issueSession(refreshed ?? { ...record, passwordHash, emailVerifiedAt: new Date().toISOString() });
  }

  /**
   * Register/update a mobile or browser push installation for a user.
   * Optional: resolves to `null` when the module was wired without a
   * `DeviceInstallationRepositoryPort` (push is not every deployment's concern).
   */
  async registerDeviceInstallation(input: NewDeviceInstallationRecord): Promise<DeviceInstallationRecord | null> {
    if (!this.deviceInstallations) return null;
    return this.deviceInstallations.upsert(input);
  }

  /** Send an invitation email. Not part of `ExtendedAuthProvider` (there is no user yet to authenticate as), but needed to drive `acceptInvitation`. */
  async inviteUser(email: string, role: UserRecord["role"]): Promise<void> {
    const normalized = normalizedEmail(email);
    let record = await this.users.findByEmail(this.config.accountId, normalized);
    if (!record) {
      record = await this.users.create({
        accountId: this.config.accountId,
        email: normalized,
        passwordHash: DUMMY_PASSWORD_HASH,
        role,
        emailVerifiedAt: null,
      });
    }

    const { rawToken } = await issueEmailToken(this.emailTokenDeps(), record.id, "invite");
    await this.emailProvider.send({
      to: record.email,
      subject: "You've been invited",
      text: `Use this token to accept your invitation: ${rawToken}`,
    });
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private toAuthUser(record: UserRecord): AuthUser {
    return {
      userId: record.id,
      tenantId: record.accountId,
      email: record.email,
      role: isRole(record.role) ? record.role : "member",
    };
  }

  private async issueSession(record: UserRecord): Promise<IdentitySession> {
    const now = new Date();
    const session = await this.sessions.create({
      userId: record.id,
      deviceId: null,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (this.config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS)).toISOString(),
    });

    const { rawToken } = await issueInitialRefreshToken(this.rotationDeps(), session.id);
    const { accessToken, expiresAt } = await this.issueAccessToken(record, session.id);

    return { user: this.toAuthUser(record), accessToken, expiresAt, refreshToken: rawToken };
  }

  private async issueAccessToken(
    record: UserRecord,
    sessionId: string,
  ): Promise<{ accessToken: string; expiresAt: number }> {
    const ttlSeconds = this.config.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
    const accessToken = await new SignJWT({
      account_id: record.accountId,
      role: record.role,
      email: record.email,
      sid: sessionId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(record.id)
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setIssuedAt()
      .setExpirationTime(expiresAtSeconds)
      .sign(this.secretKey);
    return { accessToken, expiresAt: expiresAtSeconds * 1000 };
  }

  private async verifyAccessToken(accessToken: string): Promise<IdentityAccessTokenClaims | null> {
    try {
      const { payload } = await jwtVerify<IdentityAccessTokenClaims>(accessToken, this.secretKey, {
        algorithms: ["HS256"],
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
      return payload;
    } catch {
      return null;
    }
  }

  private rotationDeps(): RotationDeps {
    return {
      port: this.refreshTokens,
      hashToken,
      generateToken,
      now: () => new Date(),
      ttlMs: this.config.refreshTokenTtlMs ?? DEFAULT_REFRESH_TOKEN_TTL_MS,
    };
  }

  private emailTokenDeps(): EmailTokenDeps {
    return {
      port: this.emailTokens,
      hashToken,
      generateToken,
      now: () => new Date(),
    };
  }
}
