import type { Principal } from "../../shared/types";
import type { Permission } from "../rbac/permissions";
import type { Role } from "../rbac/roles";

/**
 * Authentication Layer — abstraction over the auth/identity provider.
 *
 * Responsibilities: login, logout, get current user, get session,
 * verify permission.
 *
 * Business logic depends ONLY on this interface. It must never import Supabase
 * Auth (or BetterAuth / Clerk / Auth0) directly.
 */

export interface AuthUser extends Principal {
  /** Role assigned to the user within the tenant (drives RBAC). */
  readonly role: Role;
  readonly displayName?: string;
}

export interface Session {
  readonly user: AuthUser;
  /** Opaque access token issued by the provider. */
  readonly accessToken: string;
  /** Epoch millis when the session expires, if known. */
  readonly expiresAt?: number;
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export interface AuthProvider {
  /** Provider identifier, e.g. "supabase" | "betterauth" | "clerk" | "auth0". */
  readonly name: string;

  /** Authenticate with credentials and return a session. */
  login(credentials: Credentials): Promise<Session>;

  /** Invalidate the session for the given access token. */
  logout(accessToken: string): Promise<void>;

  /** Resolve the current user from an access token, or null if invalid. */
  getCurrentUser(accessToken: string): Promise<AuthUser | null>;

  /** Resolve the full session from an access token, or null if invalid. */
  getSession(accessToken: string): Promise<Session | null>;

  /**
   * Verify the given user holds the permission (tenant-aware). Delegates to the
   * provider-independent RBAC service so permission logic is identical no matter
   * which auth provider is active.
   */
  verifyPermission(user: AuthUser, permission: Permission): boolean;
}
