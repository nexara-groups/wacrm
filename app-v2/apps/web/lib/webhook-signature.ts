/**
 * Meta webhook signature verification.
 *
 * Meta signs every webhook POST body with HMAC-SHA256, keyed by the app
 * secret, and sends the hex digest (prefixed `sha256=`) in the
 * `X-Hub-Signature-256` header. This is the ONLY thing standing between the
 * public `/api/webhooks/whatsapp` endpoint and an attacker who can already
 * reach it with no credentials at all — see this route's own header and the
 * task's SECURITY section.
 *
 * Two rules make this safe, and both are why this file exists as its own
 * unit-tested module rather than being inlined in the route:
 *
 *   1. The digest MUST be computed over the RAW request bytes, before any
 *      JSON parsing. `JSON.stringify(JSON.parse(raw))` is not guaranteed to
 *      byte-for-byte match `raw` (key order, whitespace, unicode escaping,
 *      number formatting can all differ) — re-serialising and re-signing
 *      that would silently produce a digest that never matches Meta's,
 *      breaking verification in a way that looks like "it just doesn't
 *      work" rather than a loud failure. Callers MUST pass the exact bytes
 *      read off the request (`request.text()` / `request.arrayBuffer()`),
 *      never a value that has been through `JSON.parse`/`JSON.stringify`.
 *   2. The comparison MUST be constant-time. A naive `===` on hex strings
 *      leaks a timing oracle (return-early-on-first-mismatched-byte) an
 *      attacker can use to forge a valid signature byte-by-byte.
 *      `crypto.timingSafeEqual` is the only comparison used here.
 *
 * Fails closed: `assertAppSecretConfigured` throws when the app secret is
 * not set, rather than falling back to skipping verification or a hardcoded
 * default — see this file's `resolveMetaAppSecret` docstring for why a
 * hardcoded fallback is treated as a real vulnerability in this codebase.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_PREFIX = "sha256=";

/**
 * Reads `META_APP_SECRET` from the environment. Throws rather than
 * returning a default — a silent fallback here would let anyone who can
 * read this public repository's source forge a signature that verifies
 * against a production deploy that simply forgot to set the variable
 * (exactly the class of bug `lib/container.ts`'s `resolveAuthSecret` calls
 * out for `AUTH_SECRET`). Callers decide when to call this: the route calls
 * it on every POST so a mid-life unset (or a deploy that never set it) is
 * caught per-request, not just at cold start.
 */
export function resolveMetaAppSecret(): string {
  const configured = process.env.META_APP_SECRET;
  if (configured !== undefined && configured.length > 0) return configured;
  throw new Error(
    "META_APP_SECRET is not set. Refusing to accept WhatsApp webhooks without it — " +
      "an unverified webhook endpoint is a real vulnerability, not a degraded mode.",
  );
}

/** Reads `META_WEBHOOK_VERIFY_TOKEN` for the GET handshake. Same fail-closed rule as the app secret. */
export function resolveMetaVerifyToken(): string {
  const configured = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (configured !== undefined && configured.length > 0) return configured;
  throw new Error(
    "META_WEBHOOK_VERIFY_TOKEN is not set. Refusing to run the verify handshake without it.",
  );
}

/** Constant-time compare of two UTF-8 strings. `false` (never throws) on any length mismatch. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies `header` (the raw `X-Hub-Signature-256` header value, or
 * `null`/`undefined` when absent) against `rawBody` (the EXACT bytes read
 * off the request — see this file's header) using `appSecret`.
 *
 * Returns `false` — never throws — for: a missing header, a header not
 * shaped `sha256=<hex>`, a length mismatch, or a digest mismatch. The
 * caller (`route.ts`) is what turns `false` into a rejected response; this
 * function only ever answers yes/no.
 */
export function verifyMetaSignature(
  rawBody: string | Buffer,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = header.slice(SIGNATURE_PREFIX.length).trim();
  if (provided.length === 0) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return timingSafeEqualStrings(provided, expected);
}

/** Header name Meta uses — exported so the route and tests share one spelling. */
export const META_SIGNATURE_HEADER = SIGNATURE_HEADER;
