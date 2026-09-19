import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  META_SIGNATURE_HEADER,
  resolveMetaAppSecret,
  resolveMetaVerifyToken,
  timingSafeEqualStrings,
  verifyMetaSignature,
} from "./webhook-signature";

const SECRET = "test-app-secret-do-not-use-in-prod";

function signRaw(rawBody: string, secret: string = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

describe("verifyMetaSignature", () => {
  it("accepts a valid signature computed over the exact raw body", () => {
    const rawBody = '{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[]}]}';
    const header = signRaw(rawBody);
    expect(verifyMetaSignature(rawBody, header, SECRET)).toBe(true);
  });

  it("rejects a wrong signature (right shape, wrong digest)", () => {
    const rawBody = '{"object":"whatsapp_business_account","entry":[]}';
    const wrongHeader = signRaw(rawBody, "a-completely-different-secret");
    expect(verifyMetaSignature(rawBody, wrongHeader, SECRET)).toBe(false);
  });

  it("rejects a tampered body — same signature, body edited after signing", () => {
    // This is the exact bug class this module guards against: a signature
    // computed over one payload, then checked against a payload that has
    // since changed (whether by an attacker tampering in transit, or by
    // code that re-serialises the parsed JSON before hashing).
    const originalBody = '{"object":"whatsapp_business_account","entry":[{"id":"1"}]}';
    const header = signRaw(originalBody);
    const tamperedBody = '{"object":"whatsapp_business_account","entry":[{"id":"2"}]}';
    expect(verifyMetaSignature(tamperedBody, header, SECRET)).toBe(false);
  });

  it("rejects a body that was re-serialised (JSON.parse -> JSON.stringify) rather than kept raw", () => {
    // Same logical payload, different bytes: key order changed and the
    // number went from decimal string to a re-emitted literal. A verifier
    // that hashes `JSON.stringify(JSON.parse(rawBody))` instead of the raw
    // bytes would break on input exactly like this — which is the whole
    // reason `verifyMetaSignature` takes the raw string/Buffer directly and
    // documents "never parse-then-restringify" in its header.
    const rawBody = '{ "object": "whatsapp_business_account", "id": "123", "entry": [] }';
    const header = signRaw(rawBody);

    const reserialised = JSON.stringify(JSON.parse(rawBody));
    expect(reserialised).not.toBe(rawBody); // sanity: the reserialisation actually changed key order/bytes
    expect(verifyMetaSignature(reserialised, header, SECRET)).toBe(false);

    // The original raw bytes still verify against the same header.
    expect(verifyMetaSignature(rawBody, header, SECRET)).toBe(true);
  });

  it("rejects when the header is missing", () => {
    const rawBody = '{"object":"whatsapp_business_account","entry":[]}';
    expect(verifyMetaSignature(rawBody, null, SECRET)).toBe(false);
    expect(verifyMetaSignature(rawBody, undefined, SECRET)).toBe(false);
  });

  it("rejects when the header is present but empty or malformed", () => {
    const rawBody = "{}";
    expect(verifyMetaSignature(rawBody, "", SECRET)).toBe(false);
    expect(verifyMetaSignature(rawBody, "not-the-right-shape", SECRET)).toBe(false);
    expect(verifyMetaSignature(rawBody, "sha256=", SECRET)).toBe(false);
    expect(verifyMetaSignature(rawBody, "sha1=deadbeef", SECRET)).toBe(false);
  });

  it("rejects a signature of the right length that merely differs in one character", () => {
    const rawBody = '{"a":1}';
    const header = signRaw(rawBody);
    const flipped = header.slice(0, -1) + (header.endsWith("0") ? "1" : "0");
    expect(verifyMetaSignature(rawBody, flipped, SECRET)).toBe(false);
  });

  it("works identically on a Buffer as on the equivalent string", () => {
    const rawBody = '{"object":"whatsapp_business_account"}';
    const header = signRaw(rawBody);
    expect(verifyMetaSignature(Buffer.from(rawBody, "utf8"), header, SECRET)).toBe(true);
  });

  it("exports the exact header name Meta sends", () => {
    expect(META_SIGNATURE_HEADER).toBe("x-hub-signature-256");
  });
});

describe("timingSafeEqualStrings", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualStrings("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqualStrings("abc123", "abc124")).toBe(false);
  });

  it("returns false (not a throw) for different-length strings", () => {
    expect(timingSafeEqualStrings("short", "a-lot-longer")).toBe(false);
  });
});

describe("resolveMetaAppSecret / resolveMetaVerifyToken — fail closed", () => {
  it("throws when META_APP_SECRET is unset, never returning a default", () => {
    const original = process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET;
    try {
      expect(() => resolveMetaAppSecret()).toThrow(/META_APP_SECRET/);
    } finally {
      if (original !== undefined) process.env.META_APP_SECRET = original;
    }
  });

  it("returns the configured secret when set", () => {
    const original = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = "configured-secret";
    try {
      expect(resolveMetaAppSecret()).toBe("configured-secret");
    } finally {
      if (original !== undefined) process.env.META_APP_SECRET = original;
      else delete process.env.META_APP_SECRET;
    }
  });

  it("throws when META_WEBHOOK_VERIFY_TOKEN is unset", () => {
    const original = process.env.META_WEBHOOK_VERIFY_TOKEN;
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
    try {
      expect(() => resolveMetaVerifyToken()).toThrow(/META_WEBHOOK_VERIFY_TOKEN/);
    } finally {
      if (original !== undefined) process.env.META_WEBHOOK_VERIFY_TOKEN = original;
    }
  });
});
