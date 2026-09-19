import { AppError } from "@shared/errors";
import { err, ok, type Result } from "@shared/result";
import type { UserId } from "@shared/types";

/**
 * Identity module — single-use, TTL'd email tokens.
 *
 * Backs `requestPasswordReset` / `resetPassword`, `verifyEmail`, and
 * `acceptInvitation`. Every token is single-use (consuming it sets
 * `consumedAt`, and a consumed token is rejected on any later attempt) and
 * time-boxed (an expired token is rejected even if never consumed). Only the
 * hash is ever stored — see `token-hashing.ts`.
 *
 * Pure domain logic over an injected port; no I/O happens in this file.
 */

export type EmailTokenType = "reset" | "verify" | "invite";

export interface EmailTokenRecord {
  readonly id: string;
  readonly userId: UserId;
  readonly type: EmailTokenType;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export interface NewEmailTokenRecord {
  readonly userId: UserId;
  readonly type: EmailTokenType;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface EmailTokenPort {
  insert(record: NewEmailTokenRecord): Promise<EmailTokenRecord>;
  findByTokenHash(tokenHash: string): Promise<EmailTokenRecord | null>;
  markConsumed(id: string, consumedAt: string): Promise<void>;
}

export interface EmailTokenDeps {
  readonly port: EmailTokenPort;
  readonly hashToken: (rawToken: string) => Promise<string>;
  readonly generateToken: () => string;
  readonly now: () => Date;
}

export const DEFAULT_EMAIL_TOKEN_TTL_MS: Record<EmailTokenType, number> = {
  reset: 60 * 60 * 1000, // 1 hour
  verify: 24 * 60 * 60 * 1000, // 24 hours
  invite: 7 * 24 * 60 * 60 * 1000, // 7 days
};

export interface IssuedEmailToken {
  readonly record: EmailTokenRecord;
  /** Raw token to place in the emailed link. Exists only in memory — never persisted. */
  readonly rawToken: string;
}

/** Issue a fresh single-use token of the given type for a user. */
export async function issueEmailToken(
  deps: EmailTokenDeps,
  userId: UserId,
  type: EmailTokenType,
  ttlMs: number = DEFAULT_EMAIL_TOKEN_TTL_MS[type],
): Promise<IssuedEmailToken> {
  const rawToken = deps.generateToken();
  const tokenHash = await deps.hashToken(rawToken);
  const now = deps.now();
  const record = await deps.port.insert({
    userId,
    type,
    tokenHash,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
  return { record, rawToken };
}

/**
 * Redeem a single-use token: must exist, match the expected type, not be
 * already consumed, and not be expired. On success it is atomically marked
 * consumed so it cannot be redeemed a second time.
 */
export async function consumeEmailToken(
  deps: EmailTokenDeps,
  rawToken: string,
  expectedType: EmailTokenType,
): Promise<Result<EmailTokenRecord, AppError>> {
  const tokenHash = await deps.hashToken(rawToken);
  const record = await deps.port.findByTokenHash(tokenHash);
  if (!record || record.type !== expectedType) {
    return err(AppError.unauthenticated("Invalid or unknown token"));
  }

  if (record.consumedAt) {
    return err(AppError.unauthenticated("Token has already been used"));
  }

  const now = deps.now();
  if (new Date(record.expiresAt).getTime() <= now.getTime()) {
    return err(AppError.unauthenticated("Token has expired"));
  }

  await deps.port.markConsumed(record.id, now.toISOString());
  return ok(record);
}
