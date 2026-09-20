import { AppError } from "@shared/errors";
import { err, ok, type Result } from "@shared/result";

/**
 * Identity module — refresh-token rotation.
 *
 * The security core of the module. Every refresh token belongs to a
 * `familyId` established when the session's first refresh token is issued.
 * Each successful refresh:
 *   1. marks the presented token `used` (it can never be redeemed again),
 *   2. mints a brand-new token in the SAME family, linked via `rotatedFrom`.
 *
 * REUSE DETECTION: if a token that is already `used` (or already revoked) is
 * presented again, that is proof the raw token value leaked (an attacker
 * replayed a token the legitimate client already rotated past). The correct
 * response is not to reject just that token — it is to revoke the ENTIRE
 * family, so every token descended from it (including whichever one the
 * legitimate client is currently holding) stops working. That is what turns
 * a stolen refresh token into a single-use liability for the thief instead
 * of a standing backdoor.
 *
 * This file is pure domain logic: it never touches a database, the network,
 * or the clock directly. Everything effectful (persistence, hashing,
 * randomness, time) is supplied by the caller through `RotationDeps`, so the
 * rotation/reuse-detection algorithm itself can be tested with an in-memory
 * fake and no I/O.
 */

export interface RefreshTokenRecord {
  readonly id: string;
  readonly sessionId: string;
  /** Hash of the token only — the raw token is never stored. */
  readonly tokenHash: string;
  readonly familyId: string;
  /** id of the token this one replaced via rotation, or null for the family's first token. */
  readonly rotatedFrom: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Set the moment this token is redeemed by a refresh (rotated away from). */
  readonly usedAt: string | null;
  /** Set when this token (or its whole family) is revoked. */
  readonly revokedAt: string | null;
}

export interface NewRefreshTokenRecord {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly familyId: string;
  readonly rotatedFrom: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * Port the rotation logic operates over. No I/O happens inside this file —
 * an implementation (SQL-backed, D1-backed, in-memory for tests, ...) is
 * injected by the application layer.
 */
export interface RefreshTokenPort {
  findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  findFamily(familyId: string): Promise<readonly RefreshTokenRecord[]>;
  insert(record: NewRefreshTokenRecord): Promise<RefreshTokenRecord>;
  markUsed(id: string, usedAt: string): Promise<void>;
  /** Revoke every token in the family (used for reuse detection and explicit logout). */
  revokeFamily(familyId: string, revokedAt: string): Promise<void>;
}

export interface RotationDeps {
  readonly port: RefreshTokenPort;
  /** Hash a raw token for storage/lookup. Must never be reversible; see `token-hashing.ts`. */
  readonly hashToken: (rawToken: string) => Promise<string>;
  /** Generate a fresh, high-entropy raw token. */
  readonly generateToken: () => string;
  readonly now: () => Date;
  readonly ttlMs: number;
}

export interface RotatedRefreshToken {
  readonly record: RefreshTokenRecord;
  /** The raw token to hand back to the client. Exists only in memory — never persisted. */
  readonly rawToken: string;
}

/** Mint the first refresh token of a brand-new family (e.g. on login). */
export async function issueInitialRefreshToken(
  deps: RotationDeps,
  sessionId: string,
): Promise<RotatedRefreshToken> {
  const rawToken = deps.generateToken();
  const tokenHash = await deps.hashToken(rawToken);
  const now = deps.now();
  const familyId = crypto.randomUUID();
  const record = await deps.port.insert({
    sessionId,
    tokenHash,
    familyId,
    rotatedFrom: null,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + deps.ttlMs).toISOString(),
  });
  return { record, rawToken };
}

/**
 * Redeem a presented raw refresh token: on success, rotate it into a new
 * token in the same family. On reuse of an already-used/revoked token,
 * revoke the whole family and fail.
 */
export async function rotateRefreshToken(
  deps: RotationDeps,
  presentedRawToken: string,
): Promise<Result<RotatedRefreshToken, AppError>> {
  const presentedHash = await deps.hashToken(presentedRawToken);
  const existing = await deps.port.findByTokenHash(presentedHash);
  if (!existing) {
    return err(AppError.unauthenticated("Invalid refresh token"));
  }

  const now = deps.now();

  // Reuse of a token that is already used, or belongs to an already-revoked
  // family, is the signal that the raw value leaked. Nuke the family.
  if (existing.usedAt || existing.revokedAt) {
    await deps.port.revokeFamily(existing.familyId, now.toISOString());
    return err(AppError.unauthenticated("Refresh token reuse detected; session revoked"));
  }

  if (new Date(existing.expiresAt).getTime() <= now.getTime()) {
    return err(AppError.unauthenticated("Refresh token has expired"));
  }

  await deps.port.markUsed(existing.id, now.toISOString());

  const rawToken = deps.generateToken();
  const tokenHash = await deps.hashToken(rawToken);
  const record = await deps.port.insert({
    sessionId: existing.sessionId,
    tokenHash,
    familyId: existing.familyId,
    rotatedFrom: existing.id,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + deps.ttlMs).toISOString(),
  });

  return ok({ record, rawToken });
}
