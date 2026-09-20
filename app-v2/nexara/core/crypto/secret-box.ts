/**
 * Reversible encryption for secrets the system must be able to READ BACK —
 * today, a tenant's Meta access token (`WhatsAppConfigRecord.accessToken`,
 * whose docstring has always said "encrypted at rest by the caller" while no
 * caller encrypted anything).
 *
 * This is deliberately NOT `modules/identity/domain/token-hashing.ts`, and
 * the distinction is the whole reason this file exists. That module hashes:
 * one-way, for values we only ever need to COMPARE (passwords, invite
 * tokens). A Meta access token has to be sent to Meta on every outbound
 * message, so a hash is useless for it. Reaching for `hashToken` here — or,
 * worse, storing it in the clear because hashing obviously does not fit —
 * are the two mistakes this module exists to foreclose.
 *
 * AES-256-GCM via WebCrypto, so it runs unchanged in the Workers runtime
 * (no Node `crypto`, no dependency). GCM is authenticated: a tampered
 * ciphertext fails to open rather than decrypting to plausible garbage.
 *
 * CPU cost matters here — the free tier allows 10 ms per request and
 * PBKDF2 already spends 6.2 ms of it on a login. AES-GCM over a token-sized
 * string is microseconds, so sealing/opening is not a budget concern; that is
 * only true because nothing in this file stretches a key. Do not "harden"
 * this by deriving the key per call.
 */

/** GCM's standard nonce length. 96 bits is what the construction is defined for. */
const IV_BYTES = 12;

/** AES-256. The key material must be exactly this long. */
const KEY_BYTES = 32;

/**
 * Version tag on every sealed value. A rotation to a new algorithm or key
 * schedule ships as `v2.` and can be read alongside `v1.` — a format with no
 * version cannot be migrated without a downtime window.
 */
const V1 = "v1";

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

/**
 * Raised when a value that should be sealed is not — most importantly, a row
 * written before this module existed, which holds a plaintext token. Distinct
 * from a decryption failure so a migration can tell "needs sealing" apart
 * from "wrong key or tampered with", which are not the same incident.
 */
export class NotSealedError extends SecretBoxError {
  constructor() {
    super("value is not a sealed secret");
    this.name = "NotSealedError";
  }
}

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
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Imports the raw key material a deployment supplies (32 bytes, base64 or
 * base64url — a Worker secret, never a file in the repo).
 *
 * Errors here never echo the key or its length beyond the fact that it was
 * wrong: an error message is the most likely place for a secret to leak into
 * a log, and "expected 32 bytes, got 31" is enough for the operator to fix
 * their configuration without printing any part of the material.
 */
export async function importSecretKey(base64Key: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(base64Key.trim());
  } catch {
    throw new SecretBoxError("encryption key is not valid base64");
  }
  if (raw.length !== KEY_BYTES) {
    throw new SecretBoxError(`encryption key must be ${KEY_BYTES} bytes of base64-encoded material`);
  }
  return crypto.subtle.importKey("raw", raw as unknown as ArrayBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Generates fresh key material for an operator to store as a secret. Never called at request time. */
export function generateSecretKeyMaterial(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/**
 * `context` is GCM's additional authenticated data: it is not encrypted, but
 * the ciphertext cannot be opened with a different one.
 *
 * This is the multi-tenant protection, not decoration. Without it, anyone who
 * can write the database — a SQL-injection foothold, a bug in an admin tool,
 * a restored backup merged wrongly — could copy tenant A's sealed token into
 * tenant B's config row and have the system happily send B's messages with
 * A's credentials, because the ciphertext alone says nothing about whose it
 * is. Callers pass something that identifies the row (e.g.
 * `whatsapp_config:<accountId>:<phoneNumberId>`), so a moved ciphertext fails
 * to open instead of silently working.
 */
export async function sealSecret(plaintext: string, key: CryptoKey, context: string): Promise<string> {
  if (context.length === 0) {
    throw new SecretBoxError("a sealing context is required — see this module's `context` docstring");
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoder = new TextEncoder();
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as ArrayBuffer, additionalData: encoder.encode(context) as unknown as ArrayBuffer },
    key,
    encoder.encode(plaintext) as unknown as ArrayBuffer,
  );
  return `${V1}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

/** `true` for a value this module produced. Everything else — including a legacy plaintext token — is `false`. */
export function isSealed(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts[0] === V1 && parts[1]!.length > 0 && parts[2]!.length > 0;
}

/**
 * Opens a sealed value. Throws `NotSealedError` for anything this module did
 * not produce, and a generic `SecretBoxError` for a wrong key, a wrong
 * context, or tampering — deliberately indistinguishable from each other, and
 * deliberately carrying neither the ciphertext nor any part of the key, so a
 * caught-and-logged failure cannot become the leak.
 */
export async function openSecret(sealed: string, key: CryptoKey, context: string): Promise<string> {
  if (!isSealed(sealed)) throw new NotSealedError();
  const [, ivPart, cipherPart] = sealed.split(".") as [string, string, string];

  let iv: Uint8Array;
  let cipher: Uint8Array;
  try {
    iv = fromBase64Url(ivPart);
    cipher = fromBase64Url(cipherPart);
  } catch {
    throw new SecretBoxError("sealed secret is malformed");
  }
  if (iv.length !== IV_BYTES) throw new SecretBoxError("sealed secret is malformed");

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv as unknown as ArrayBuffer,
        additionalData: new TextEncoder().encode(context) as unknown as ArrayBuffer,
      },
      key,
      cipher as unknown as ArrayBuffer,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new SecretBoxError("sealed secret could not be opened with this key and context");
  }
}
