import type { UserId } from "../../shared/types";
import type { AuthProvider } from "./auth-provider.interface";

export interface RegistrationCredentials {
  readonly userId: UserId;
  readonly email: string;
  readonly password: string;
}

export interface AccountRegistration {
  readonly userId: UserId;
  readonly email: string;
  readonly created: boolean;
}

/** Optional extension for providers that own email/password credentials. */
export interface CredentialsAuthProvider extends AuthProvider {
  register(credentials: RegistrationCredentials): Promise<AccountRegistration>;
  requestPasswordReset(email: string): Promise<{ token: string; email: string } | null>;
  resetPassword(token: string, newPassword: string): Promise<boolean>;
  requestEmailVerification(email: string): Promise<{ token: string; email: string } | null>;
  verifyEmail(token: string): Promise<boolean>;
  revokeUserSessions(userId: UserId): Promise<void>;
}
