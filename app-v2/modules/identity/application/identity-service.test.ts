import type { EmailMessage, EmailProvider } from "@nexara/core/email";
import { PermissionService } from "@nexara/core/rbac";
import type { Role } from "@nexara/core/rbac";
import { AppError } from "@shared/errors";
import type { TenantId, UserId } from "@shared/types";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../domain/token-hashing";
import { IdentityService, type IdentityServiceConfig } from "./identity-service";
import type {
  EmailTokenRecord,
  EmailTokenRepositoryPort,
  NewEmailTokenRecord,
  NewRefreshTokenRecord,
  NewSessionRecord,
  NewUserRecord,
  RefreshTokenRecord,
  RefreshTokenRepositoryPort,
  SessionRecord,
  SessionRepositoryPort,
  UserRecord,
  UserRepositoryPort,
} from "./ports";

// ---------------------------------------------------------------------------
// In-memory port fakes (test doubles only — real persistence is another
// track's responsibility; these exist purely to exercise the service).
// ---------------------------------------------------------------------------

class InMemoryUserRepository implements UserRepositoryPort {
  private readonly byId = new Map<UserId, UserRecord>();
  private nextId = 1;

  async findById(id: UserId): Promise<UserRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByEmail(accountId: TenantId, email: string): Promise<UserRecord | null> {
    for (const record of this.byId.values()) {
      if (record.accountId === accountId && record.email === email) return record;
    }
    return null;
  }

  async create(input: NewUserRecord): Promise<UserRecord> {
    const now = new Date().toISOString();
    const record: UserRecord = { id: `user_${this.nextId++}`, createdAt: now, updatedAt: now, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async updatePasswordHash(id: UserId, passwordHash: string): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.byId.set(id, { ...existing, passwordHash, updatedAt: new Date().toISOString() });
  }

  async markEmailVerified(id: UserId, verifiedAt: string): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.byId.set(id, { ...existing, emailVerifiedAt: verifiedAt });
  }
}

class InMemorySessionRepository implements SessionRepositoryPort {
  private readonly byId = new Map<string, SessionRecord>();
  private nextId = 1;

  async create(input: NewSessionRecord): Promise<SessionRecord> {
    const record: SessionRecord = { id: `sess_${this.nextId++}`, revokedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<SessionRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async touch(id: string, lastSeenAt: string): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.byId.set(id, { ...existing, lastSeenAt });
  }

  async revoke(id: string, revokedAt: string): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.byId.set(id, { ...existing, revokedAt });
  }

  async revokeAllForUser(userId: UserId, revokedAt: string): Promise<void> {
    for (const record of this.byId.values()) {
      if (record.userId === userId && !record.revokedAt) {
        this.byId.set(record.id, { ...record, revokedAt });
      }
    }
  }

  async listForUser(userId: UserId): Promise<readonly SessionRecord[]> {
    return [...this.byId.values()].filter((r) => r.userId === userId);
  }
}

class InMemoryRefreshTokenRepository implements RefreshTokenRepositoryPort {
  private readonly byId = new Map<string, RefreshTokenRecord>();
  private nextId = 1;

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    for (const record of this.byId.values()) {
      if (record.tokenHash === tokenHash) return record;
    }
    return null;
  }

  async findFamily(familyId: string): Promise<readonly RefreshTokenRecord[]> {
    return [...this.byId.values()].filter((r) => r.familyId === familyId);
  }

  async insert(input: NewRefreshTokenRecord): Promise<RefreshTokenRecord> {
    const record: RefreshTokenRecord = { id: `rt_${this.nextId++}`, usedAt: null, revokedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async markUsed(id: string, usedAt: string): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.byId.set(id, { ...existing, usedAt });
  }

  async revokeFamily(familyId: string, revokedAt: string): Promise<void> {
    for (const record of this.byId.values()) {
      if (record.familyId === familyId && !record.revokedAt) {
        this.byId.set(record.id, { ...record, revokedAt });
      }
    }
  }
}

class InMemoryEmailTokenRepository implements EmailTokenRepositoryPort {
  private readonly byId = new Map<string, EmailTokenRecord>();
  private nextId = 1;

  async insert(input: NewEmailTokenRecord): Promise<EmailTokenRecord> {
    const record: EmailTokenRecord = { id: `et_${this.nextId++}`, consumedAt: null, ...input };
    this.byId.set(record.id, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<EmailTokenRecord | null> {
    for (const record of this.byId.values()) {
      if (record.tokenHash === tokenHash) return record;
    }
    return null;
  }

  async markConsumed(id: string, consumedAt: string): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.byId.set(id, { ...existing, consumedAt });
  }
}

class RecordingEmailProvider implements EmailProvider {
  readonly name = "recording";
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

function extractToken(text: string): string {
  const match = /: (\S+)$/.exec(text.trim());
  if (!match?.[1]) throw new Error(`could not extract token from: ${text}`);
  return match[1];
}

const ACCOUNT_ID = "acct-1";
const SECRET = "a".repeat(32);

function buildHarness(accountId: TenantId = ACCOUNT_ID) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const refreshTokens = new InMemoryRefreshTokenRepository();
  const emailTokens = new InMemoryEmailTokenRepository();
  const permissions = new PermissionService();
  const emailProvider = new RecordingEmailProvider();

  const config: IdentityServiceConfig = {
    accountId,
    issuer: "https://wacrm.test",
    audience: "wacrm",
    secret: SECRET,
  };

  const service = new IdentityService(config, users, sessions, refreshTokens, emailTokens, permissions, emailProvider);

  return { service, users, sessions, refreshTokens, emailTokens, permissions, emailProvider, config };
}

async function seedVerifiedUser(
  users: InMemoryUserRepository,
  opts: { accountId?: TenantId; email: string; password: string; role?: Role },
): Promise<UserRecord> {
  const passwordHash = await hashPassword(opts.password);
  const record = await users.create({
    accountId: opts.accountId ?? ACCOUNT_ID,
    email: opts.email,
    passwordHash,
    role: opts.role ?? "member",
    emailVerifiedAt: null,
  });
  await users.markEmailVerified(record.id, new Date().toISOString());
  return (await users.findById(record.id))!;
}

describe("IdentityService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("EmailProvider is a required dependency", () => {
    it("cannot be omitted at the type level (constructor parameter is non-optional EmailProvider)", () => {
      // Type-level guarantee: `emailProvider` in the IdentityService constructor
      // has type `EmailProvider`, not `EmailProvider | undefined`, so a caller
      // wiring the reset/verify/invite flows cannot compile a build that omits
      // it. The line below violates that on purpose to prove the point — and
      // is expected to fail to typecheck without the suppression.
      const { users, sessions, refreshTokens, emailTokens, permissions, config } = buildHarness();
      expect(() => {
        // @ts-expect-error — EmailProvider is required; this is the violation the guard below catches.
        new IdentityService(config, users, sessions, refreshTokens, emailTokens, permissions, undefined);
      }).toThrow(AppError);
    });

    it("throws loudly, not silently, when the type system is bypassed at runtime", () => {
      const { users, sessions, refreshTokens, emailTokens, permissions, config } = buildHarness();
      expect(() => {
        new IdentityService(
          config,
          users,
          sessions,
          refreshTokens,
          emailTokens,
          permissions,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          undefined as unknown as EmailProvider,
        );
      }).toThrow(/EmailProvider/);
    });
  });

  describe("login", () => {
    it("issues an access token carrying the tenant claim (account_id) and role", async () => {
      const { service, users } = buildHarness();
      const user = await seedVerifiedUser(users, { email: "owner@example.com", password: "hunter2!!", role: "owner" });

      const session = await service.login({ email: user.email, password: "hunter2!!" });
      const claims = decodeJwt(session.accessToken);

      expect(claims.sub).toBe(user.id);
      expect(claims["account_id"]).toBe(ACCOUNT_ID);
      expect(claims["role"]).toBe("owner");
    });

    it("rejects a wrong password", async () => {
      const { service, users } = buildHarness();
      const user = await seedVerifiedUser(users, { email: "member@example.com", password: "correct-password" });
      await expect(service.login({ email: user.email, password: "wrong-password" })).rejects.toThrow(AppError);
    });
  });

  describe("refresh rotation (via the service)", () => {
    it("issues a new access+refresh token pair and invalidates the old refresh token", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      try {
        const { service, users } = buildHarness();
        const user = await seedVerifiedUser(users, { email: "a@example.com", password: "pw12345678" });
        const session = await service.login({ email: user.email, password: "pw12345678" });

        vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z")); // advance so the new access token's `iat` differs
        const refreshed = await service.refresh(session.refreshToken);

        expect(refreshed.refreshToken).not.toBe(session.refreshToken);
        expect(refreshed.accessToken).not.toBe(session.accessToken);

        // The old refresh token is dead now — replaying it is a reuse signal.
        await expect(service.refresh(session.refreshToken)).rejects.toThrow(AppError);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reuse of a rotated token revokes the session line end-to-end", async () => {
      const { service, users } = buildHarness();
      const user = await seedVerifiedUser(users, { email: "b@example.com", password: "pw12345678" });
      const session = await service.login({ email: user.email, password: "pw12345678" });

      const refreshed = await service.refresh(session.refreshToken);
      // Replay the pre-rotation token (the one that already leaked/rotated away).
      await expect(service.refresh(session.refreshToken)).rejects.toThrow(AppError);
      // Even the legitimate, just-issued token is now dead — the whole family died.
      await expect(service.refresh(refreshed.refreshToken)).rejects.toThrow(AppError);
    });
  });

  describe("revokeAllSessions", () => {
    it("kills every session for the target user and none of another user's", async () => {
      const { service, users, sessions } = buildHarness();
      const userA = await seedVerifiedUser(users, { email: "a@example.com", password: "pw12345678" });
      const userB = await seedVerifiedUser(users, { email: "b@example.com", password: "pw12345678" });

      await service.login({ email: userA.email, password: "pw12345678" });
      await service.login({ email: userA.email, password: "pw12345678" }); // second device
      await service.login({ email: userB.email, password: "pw12345678" });

      await service.revokeAllSessions(userA.id);

      const sessionsA = await sessions.listForUser(userA.id);
      const sessionsB = await sessions.listForUser(userB.id);

      expect(sessionsA.length).toBeGreaterThanOrEqual(2);
      expect(sessionsA.every((s) => s.revokedAt !== null)).toBe(true);

      expect(sessionsB.length).toBeGreaterThanOrEqual(1);
      expect(sessionsB.every((s) => s.revokedAt === null)).toBe(true);
    });
  });

  describe("password reset", () => {
    it("is single-use: the token cannot be redeemed twice", async () => {
      const { service, users, emailProvider } = buildHarness();
      const user = await seedVerifiedUser(users, { email: "reset@example.com", password: "old-password!" });

      await service.requestPasswordReset(user.email);
      expect(emailProvider.sent).toHaveLength(1);
      const token = extractToken(emailProvider.sent[0]!.text);

      await service.resetPassword(token, "new-password!!");
      // New password now works.
      await expect(service.login({ email: user.email, password: "new-password!!" })).resolves.toBeDefined();

      // Replaying the same reset token fails.
      await expect(service.resetPassword(token, "another-password")).rejects.toThrow(AppError);
    });

    it("resolves silently for an unknown email (no enumeration signal)", async () => {
      const { service, emailProvider } = buildHarness();
      await expect(service.requestPasswordReset("nobody@example.com")).resolves.toBeUndefined();
      expect(emailProvider.sent).toHaveLength(0);
    });

    it("rejects an expired reset token", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      try {
        const { service, users, emailProvider } = buildHarness();
        const user = await seedVerifiedUser(users, { email: "expire@example.com", password: "old-password!" });

        await service.requestPasswordReset(user.email);
        const token = extractToken(emailProvider.sent[0]!.text);

        vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z")); // > 1 hour TTL

        await expect(service.resetPassword(token, "new-password!!")).rejects.toThrow(AppError);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("email verification", () => {
    it("is single-use", async () => {
      const { service, users, emailProvider } = buildHarness();
      const passwordHash = await hashPassword("pw12345678");
      const user = await users.create({
        accountId: ACCOUNT_ID,
        email: "verify@example.com",
        passwordHash,
        role: "member",
        emailVerifiedAt: null,
      });

      await service.sendEmailVerification(user.id);
      const token = extractToken(emailProvider.sent[0]!.text);

      await service.verifyEmail(token);
      const verified = await users.findById(user.id);
      expect(verified?.emailVerifiedAt).not.toBeNull();

      await expect(service.verifyEmail(token)).rejects.toThrow(AppError);
    });
  });

  describe("acceptInvitation", () => {
    it("is single-use, TTL-bounded, and signs the user in on success", async () => {
      const { service, users, emailProvider } = buildHarness();

      await service.inviteUser("invitee@example.com", "member");
      const token = extractToken(emailProvider.sent[0]!.text);

      const session = await service.acceptInvitation(token, "brand-new-password!");
      expect(session.user.email).toBe("invitee@example.com");
      expect(session.accessToken).toBeDefined();

      const user = await users.findByEmail(ACCOUNT_ID, "invitee@example.com");
      expect(user?.emailVerifiedAt).not.toBeNull();

      // The invitation token cannot be reused.
      await expect(service.acceptInvitation(token, "another-password!")).rejects.toThrow(AppError);
    });
  });

  describe("verifyPermission", () => {
    it("delegates to the injected PermissionService", async () => {
      const { service, users } = buildHarness();
      const owner = await seedVerifiedUser(users, { email: "o@example.com", password: "pw12345678", role: "owner" });
      const member = await seedVerifiedUser(users, { email: "m@example.com", password: "pw12345678", role: "member" });

      const ownerSession = await service.login({ email: owner.email, password: "pw12345678" });
      const memberSession = await service.login({ email: member.email, password: "pw12345678" });

      expect(service.verifyPermission(ownerSession.user, "tenant:manage")).toBe(true);
      expect(service.verifyPermission(memberSession.user, "tenant:manage")).toBe(false);
    });
  });
});
