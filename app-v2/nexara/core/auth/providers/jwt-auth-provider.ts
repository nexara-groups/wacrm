import * as bcrypt from "bcryptjs";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { AppError } from "../../../shared/errors";
import { createTenantContext } from "../../context";
import { isRole } from "../../rbac";
import type { PermissionService } from "../../rbac/permission-service";
import type { Permission } from "../../rbac/permissions";
import type { AuthProvider, AuthUser, Credentials, Session } from "../auth-provider.interface";
import type { AccountRegistration, CredentialsAuthProvider, RegistrationCredentials } from "../credentials-auth-provider.interface";
import type { Credential, CredentialsRepository } from "../credentials-repository.interface";

export interface JwtAuthConfig {
  readonly secret: string;
  readonly tenantId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly passwordCost?: number;
  readonly memberSessionSeconds?: number;
  readonly privilegedSessionSeconds?: number;
}

interface JwtClaims extends JWTPayload {
  readonly tenantId: string;
  readonly email: string;
  readonly role: string;
  readonly sv: number;
}

const DUMMY_PASSWORD_HASH = "$2b$12$kUx7PdyTpDofXV4NpJaAKePXb2PHSHaoNcZBTb8.whxoY2qqZnz62";
const MEMBER_SESSION_SECONDS = 60 * 60 * 24 * 7;
const PRIVILEGED_SESSION_SECONDS = 60 * 60 * 24;

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** D1-compatible, self-hosted email/password authentication. */
export class JwtAuthProvider implements AuthProvider, CredentialsAuthProvider {
  readonly name = "jwt";
  private readonly secretKey: Uint8Array;

  constructor(
    private readonly config: JwtAuthConfig,
    private readonly credentials: CredentialsRepository,
    private readonly permissions: PermissionService,
  ) {
    this.secretKey = new TextEncoder().encode(config.secret);
    if (this.secretKey.byteLength < 32) {
      throw AppError.validation("JWT secret must contain at least 32 bytes");
    }
  }

  async login(credentials: Credentials): Promise<Session> {
    const record = await this.credentials.findByEmail(this.tenant(), normalizedEmail(credentials.email));
    if (!record) {
      await bcrypt.compare(credentials.password, DUMMY_PASSWORD_HASH);
      throw AppError.unauthenticated("Invalid email or password");
    }
    if (!await bcrypt.compare(credentials.password, record.passwordHash)) {
      throw AppError.unauthenticated("Invalid email or password");
    }
    if (!record.verifiedAt) throw AppError.forbidden("Verify your email before logging in");
    return this.issueSession(record);
  }

  async register(input: RegistrationCredentials): Promise<AccountRegistration> {
    const email = normalizedEmail(input.email);
    const passwordHash = await bcrypt.hash(input.password, this.config.passwordCost ?? 12);
    const existing = await this.credentials.findByEmail(this.tenant(), email);
    if (existing) return { userId: existing.userId, email: existing.email, created: false };
    const record = await this.credentials.create(this.tenant(), {
      userId: input.userId,
      email,
      passwordHash,
      role: "member",
      verifiedAt: null,
    });
    return { userId: record.userId, email: record.email, created: true };
  }

  async requestPasswordReset(email: string): Promise<{ token: string; email: string } | null> {
    const record = await this.credentials.findByEmail(this.tenant(), normalizedEmail(email));
    if (!record) return null;
    const token = randomToken();
    await this.credentials.createPasswordReset(this.tenant(), {
      tokenHash: await sha256Hex(token),
      userId: record.userId,
      email: record.email,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    return { token, email: record.email };
  }

  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    const tokenHash = await sha256Hex(token);
    const owner = await this.credentials.findUsablePasswordReset(this.tenant(), tokenHash);
    if (!owner) return false;
    const passwordHash = await bcrypt.hash(newPassword, this.config.passwordCost ?? 12);
    return this.credentials.redeemPasswordReset(this.tenant(), tokenHash, owner.userId, passwordHash);
  }

  async requestEmailVerification(email: string): Promise<{ token: string; email: string } | null> {
    const record = await this.credentials.findByEmail(this.tenant(), normalizedEmail(email));
    if (!record || record.verifiedAt) return null;
    const token = randomToken();
    await this.credentials.createEmailVerification(this.tenant(), {
      tokenHash: await sha256Hex(token),
      userId: record.userId,
      email: record.email,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    return { token, email: record.email };
  }

  async verifyEmail(token: string): Promise<boolean> {
    const tokenHash = await sha256Hex(token);
    const owner = await this.credentials.findUsableEmailVerification(this.tenant(), tokenHash);
    return owner
      ? this.credentials.redeemEmailVerification(this.tenant(), tokenHash, owner.userId)
      : false;
  }

  async logout(accessToken: string): Promise<void> {
    const verified = await this.verifyToken(accessToken);
    if (verified?.payload.sub) await this.revokeUserSessions(verified.payload.sub);
  }

  async revokeUserSessions(userId: string): Promise<void> {
    await this.credentials.revokeSessions(this.tenant(), userId);
  }

  async getCurrentUser(accessToken: string): Promise<AuthUser | null> {
    try {
      const verified = await this.verifyToken(accessToken);
      if (!verified?.payload.sub) return null;
      const record = await this.credentials.findByUserId(this.tenant(), verified.payload.sub);
      if (!record || record.sessionVersion !== verified.payload.sv) return null;
      return this.toAuthUser(record);
    } catch {
      return null;
    }
  }

  async getSession(accessToken: string): Promise<Session | null> {
    const user = await this.getCurrentUser(accessToken);
    return user ? { user, accessToken } : null;
  }

  verifyPermission(user: AuthUser, permission: Permission): boolean {
    return this.permissions.can(user.role, permission);
  }

  private tenant() {
    return createTenantContext(this.config.tenantId);
  }

  private async issueSession(record: Credential): Promise<Session> {
    const lifetime = record.role === "member"
      ? this.config.memberSessionSeconds ?? MEMBER_SESSION_SECONDS
      : this.config.privilegedSessionSeconds ?? PRIVILEGED_SESSION_SECONDS;
    const expiresAt = Math.floor(Date.now() / 1000) + lifetime;
    const accessToken = await new SignJWT({
      tenantId: record.tenantId,
      email: record.email,
      role: record.role,
      sv: record.sessionVersion,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(record.userId)
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(this.secretKey);
    return { user: this.toAuthUser(record), accessToken, expiresAt: expiresAt * 1000 };
  }

  private verifyToken(accessToken: string) {
    return jwtVerify<JwtClaims>(accessToken, this.secretKey, {
      algorithms: ["HS256"],
      issuer: this.config.issuer,
      audience: this.config.audience,
    }).catch(() => null);
  }

  private toAuthUser(record: Credential): AuthUser {
    return {
      userId: record.userId,
      tenantId: record.tenantId,
      email: record.email,
      role: isRole(record.role) ? record.role : "member",
    };
  }
}
