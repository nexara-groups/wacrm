import { describe, expect, it } from "vitest";
import {
  generateSecretKeyMaterial,
  importSecretKey,
  isSealed,
  NotSealedError,
  openSecret,
  sealSecret,
  SecretBoxError,
} from "./secret-box";

const CONTEXT = "whatsapp_config:acct-a:1234567890";
const TOKEN = "EAAG_a_meta_access_token_shaped_string_0123456789";

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function key(): Promise<CryptoKey> {
  return importSecretKey(generateSecretKeyMaterial());
}

describe("secret box", () => {
  it("round-trips a token", async () => {
    const k = await key();
    expect(await openSecret(await sealSecret(TOKEN, k, CONTEXT), k, CONTEXT)).toBe(TOKEN);
  });

  it("round-trips non-ASCII text", async () => {
    const k = await key();
    const plaintext = "टोकन — 🔐 — ключ";
    expect(await openSecret(await sealSecret(plaintext, k, CONTEXT), k, CONTEXT)).toBe(plaintext);
  });

  it("never produces the same ciphertext twice for the same input", async () => {
    // A reused GCM nonce under one key breaks the construction outright, so
    // this is the property the whole scheme rests on, not a nicety.
    const k = await key();
    const seals = new Set<string>();
    for (let i = 0; i < 25; i += 1) seals.add(await sealSecret(TOKEN, k, CONTEXT));
    expect(seals.size).toBe(25);
  });

  it("refuses to open a ciphertext moved to another tenant's row", async () => {
    // The attack this defends: copy tenant A's sealed token into tenant B's
    // config row and let the system send B's traffic on A's credentials.
    const k = await key();
    const sealed = await sealSecret(TOKEN, k, "whatsapp_config:acct-a:111");
    await expect(openSecret(sealed, k, "whatsapp_config:acct-b:111")).rejects.toThrow(SecretBoxError);
  });

  it("refuses a tampered ciphertext", async () => {
    // Tamper at the BYTE level, not by editing a base64url character. The
    // final character of a base64url string carries padding bits that decode
    // to nothing, so changing it can leave the decoded bytes identical — a
    // first version of this test did exactly that and passed or failed
    // depending on which character the ciphertext happened to end with.
    const k = await key();
    const sealed = await sealSecret(TOKEN, k, CONTEXT);
    const [v, iv, cipher] = sealed.split(".") as [string, string, string];

    const bytes = decodeBase64Url(cipher);
    for (const position of [0, Math.floor(bytes.length / 2), bytes.length - 1]) {
      const flipped = Uint8Array.from(bytes);
      flipped[position]! ^= 0xff;
      await expect(openSecret(`${v}.${iv}.${encodeBase64Url(flipped)}`, k, CONTEXT)).rejects.toThrow(
        SecretBoxError,
      );
    }
  });

  it("refuses the wrong key", async () => {
    const sealed = await sealSecret(TOKEN, await key(), CONTEXT);
    await expect(openSecret(sealed, await key(), CONTEXT)).rejects.toThrow(SecretBoxError);
  });

  it("tells a legacy PLAINTEXT token apart from a sealed one", async () => {
    // Existing rows hold unencrypted tokens. A migration has to be able to
    // ask "is this sealed yet?" without attempting a decryption that would
    // fail for two different reasons.
    const k = await key();
    expect(isSealed(TOKEN)).toBe(false);
    expect(isSealed(await sealSecret(TOKEN, k, CONTEXT))).toBe(true);
    await expect(openSecret(TOKEN, k, CONTEXT)).rejects.toThrow(NotSealedError);
  });

  it("rejects key material that is not 32 bytes", async () => {
    await expect(importSecretKey(btoa("too-short"))).rejects.toThrow(SecretBoxError);
  });

  it("requires a context, so an unbound ciphertext cannot be created by omission", async () => {
    await expect(sealSecret(TOKEN, await key(), "")).rejects.toThrow(SecretBoxError);
  });

  it("never puts the secret, the key or the ciphertext in an error message", async () => {
    // An error message is the likeliest place for a secret to reach a log.
    const material = generateSecretKeyMaterial();
    const k = await importSecretKey(material);
    const sealed = await sealSecret(TOKEN, k, CONTEXT);
    const otherKey = await key();
    // Thunks, not promises: four rejected promises created at once would be
    // "unhandled" for a tick before the loop reaches them, which vitest
    // reports as an error even though every one of them is awaited here.
    const attempts: readonly (() => Promise<unknown>)[] = [
      () => openSecret(sealed, otherKey, CONTEXT),
      () => openSecret(sealed, k, "wrong:context"),
      () => openSecret(TOKEN, k, CONTEXT),
      () => importSecretKey("not-32-bytes"),
    ];
    const messages: string[] = [];
    for (const attempt of attempts) {
      await attempt().catch((e: unknown) => messages.push(e instanceof Error ? e.message : String(e)));
    }
    expect(messages).toHaveLength(4);
    for (const message of messages) {
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(material);
      expect(message).not.toContain(sealed.split(".")[2]);
    }
  });
});
