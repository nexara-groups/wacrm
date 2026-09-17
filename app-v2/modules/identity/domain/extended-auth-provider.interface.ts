import type { AuthProvider, Session } from "@nexara/core/auth";
import type { UserId } from "@shared/types";

/**
 * Identity module — Extended AuthProvider contract.
 *
 * Per docs/rebuild discussion/phase-0/AUTH_EXTENSION.md: the framework ships
 * `AuthProvider` with only login/logout/getCurrentUser/getSession/
 * verifyPermission. This module extends that SAME interface (it is not a
 * parallel contract) with rotating-refresh-token sessions and the
 * self-service account flows (password reset, email verification,
 * invitations). Anything typed against the framework's `AuthProvider`
 * continues to work unchanged against an `ExtendedAuthProvider`.
 */

/** A single device/browser session, as surfaced to the account owner. */
export interface DeviceSession {
  readonly sessionId: string;
  readonly userId: UserId;
  /** Client-supplied device identifier, when known (mobile installs, browsers that send one). */
  readonly deviceId: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  /** Non-null once the session has been revoked (logout, reuse detection, admin action). */
  readonly revokedAt: string | null;
}

/**
 * The framework `Session` shape, extended with the opaque rotating refresh
 * token. `Session` itself carries no field for it (it is a framework type
 * this module must not modify), so flows that mint a new refresh token
 * return this structurally-compatible subtype instead — callers that only
 * know about `Session` keep working; callers that need the refresh token
 * (to set an httpOnly cookie, or hand it to a mobile client's secure
 * storage) can use it.
 */
export interface IdentitySession extends Session {
  readonly refreshToken: string;
}

export interface ExtendedAuthProvider extends AuthProvider {
  /**
   * Exchange a refresh token for a new session. The refresh token is
   * rotating: presenting the same raw token twice is reuse and revokes the
   * entire token family (see `domain/refresh-token-rotation.ts`).
   */
  refresh(refreshToken: string): Promise<Session>;

  /** Revoke one session (e.g. "log out this device"). */
  revokeSession(sessionId: string): Promise<void>;

  /** Revoke every session belonging to a user (e.g. "log out everywhere"). */
  revokeAllSessions(userId: UserId): Promise<void>;

  /** List a user's known sessions ("devices"), revoked or not. */
  listSessions(userId: UserId): Promise<DeviceSession[]>;

  /**
   * Begin a password-reset flow for the given email. Always resolves
   * regardless of whether the email is registered, so callers cannot use
   * this to enumerate accounts.
   */
  requestPasswordReset(email: string): Promise<void>;

  /** Consume a single-use password-reset token and set a new password. */
  resetPassword(token: string, newPassword: string): Promise<void>;

  /** Consume a single-use email-verification token. */
  verifyEmail(token: string): Promise<void>;

  /** Consume a single-use invitation token, set a password, and sign the user in. */
  acceptInvitation(token: string, password: string): Promise<Session>;
}
