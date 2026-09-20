/**
 * Identity module — Workers-safe hashing.
 *
 * Per AUTH_EXTENSION.md: hashing must be Workers-safe only — WebCrypto
 * PBKDF2 (high iteration count) or a WASM argon2id. Node `bcrypt`/`bcryptjs`
 * MUST NOT be used anywhere in this module (bcryptjs relies on Node's
 * native/JS binding path that the framework does not guarantee inside the
 * Workers runtime the spec targets).
 *
 * Two hashing shapes are provided, both WebCrypto-only:
 *  - `hashPassword` / `verifyPassword` — salted PBKDF2-HMAC-SHA256 for
 *    low-entropy, user-chosen secrets (account passwords). Salted + slow by
 *    design, exactly like the bcrypt call it replaces.
 *  - `hashToken` — deterministic (unsalted) SHA-256 for HIGH-entropy,
 *    server-generated opaque tokens (refresh / reset / verify / invite).
 *    These tokens carry 256 bits of randomness themselves, so a fast,
 *    lookup-able hash is the correct tool: it lets a port find the matching
 *    record by hash without a table scan, and brute-forcing a 256-bit random
 *    value through a fast hash is infeasible regardless of hash speed. Using
 *    PBKDF2 here would only make lookups impossible (PBKDF2 is salted, so
 *    the same raw value produces a different digest every time) without
 *    adding any real resistance.
 *
 * Only hashes are ever returned from `hashPassword`/`hashToken` — callers
 * must never persist the raw secret/token.
 */

const PBKDF2_ITERATIONS = 210_000; // OWASP-recommended floor for PBKDF2-HMAC-SHA256 (2023+)
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BITS = 256;
const PBKDF2_SCHEME = "pbkdf2-sha256";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveBits(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    PBKDF2_KEY_BITS,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Hash a low-entropy, user-chosen secret (account password) with salted PBKDF2. */
export async function hashPassword(password: string, iterations: number = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const derived = await deriveBits(password, salt, iterations);
  return `${PBKDF2_SCHEME}$${iterations}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

/** Verify a password against a hash produced by `hashPassword`. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, iterationsRaw, saltRaw, hashRaw, ...rest] = encoded.split("$");
  if (rest.length > 0 || scheme !== PBKDF2_SCHEME || !iterationsRaw || !saltRaw || !hashRaw) {
    return false;
  }
  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const salt = fromBase64Url(saltRaw);
  const expected = fromBase64Url(hashRaw);
  const actual = await deriveBits(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

/**
 * A dummy PBKDF2 hash to compare against when no account record was found,
 * so a lookup miss takes roughly the same time as a real password check
 * (mitigates user-enumeration via response timing). Not a real secret.
 */
export const DUMMY_PASSWORD_HASH =
  `${PBKDF2_SCHEME}$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

/** Deterministic SHA-256 hex digest — for high-entropy, server-generated opaque tokens only. */
export async function hashToken(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Generate a cryptographically random, URL-safe opaque token (raw, unhashed — never persist it). */
export function generateToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}
