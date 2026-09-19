/**
 * Resume-token generation — the opaque, high-entropy value that lets a
 * returning user (or the `/onboarding/complete` deep link — see
 * META_ONBOARDING_FLOW.md "Web-first, mobile bridges") reattach to their
 * in-progress `onboarding_sessions` row after the tab/app was closed
 * mid-flow.
 *
 * WebCrypto-only, matching `modules/identity/domain/token-hashing.ts`'s
 * rationale: Workers-safe, no Node-only APIs. Unlike identity's
 * password-reset/refresh tokens, this value is looked up directly (not
 * hashed-then-compared) — it grants no more than "resume this one session",
 * is single-tenant-scoped by the repository's `account_id` filter on every
 * lookup, and is regenerated whenever a session reaches a terminal state, so
 * the exposure of a lookup-by-raw-value design is bounded the same way a
 * session cookie's is.
 */

const RESUME_TOKEN_BYTES = 32; // 256 bits

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a fresh, URL-safe resume token. */
export function generateResumeToken(): string {
  const bytes = new Uint8Array(RESUME_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}
