/**
 * The narrow seal/open port a repository depends on, so persistence code
 * never touches WebCrypto, a key, or this module's wire format directly —
 * and so a test can supply a fake without standing up key material.
 *
 * `null` is a legitimate value for a cipher in development and in tests,
 * where no key is configured; what it must never be is a silent default in
 * production. The composition root is responsible for refusing to start
 * without a key there, exactly as it already refuses a missing `AUTH_SECRET`
 * (`apps/web/lib/container.ts`). A repository handed `null` stores plaintext,
 * which is only acceptable because that path also refuses to READ a sealed
 * row — see `openStoredSecret`.
 */
import { isSealed, openSecret, sealSecret, SecretBoxError } from "./secret-box";

export interface SecretCipher {
  seal(plaintext: string, context: string): Promise<string>;
  open(sealed: string, context: string): Promise<string>;
}

export function createSecretCipher(key: CryptoKey): SecretCipher {
  return {
    seal: (plaintext, context) => sealSecret(plaintext, key, context),
    open: (sealed, context) => openSecret(sealed, key, context),
  };
}

/**
 * Reads a stored secret that may predate encryption.
 *
 * Rows written before the cipher existed hold plaintext, and there is no
 * flag day on which they all become sealed — so a read has to handle both.
 * The two directions are deliberately NOT symmetric:
 *
 *  - A plaintext row is returned as-is, whether or not a cipher is
 *    configured. That is the migration path: the value is already readable,
 *    and refusing it would take a working deployment down for a reason the
 *    operator cannot act on quickly.
 *  - A SEALED row with no cipher configured THROWS. The alternative is
 *    handing the caller a base64 blob it would cheerfully send to Meta as an
 *    access token — a failure that surfaces as a confusing vendor error
 *    rather than as the configuration mistake it actually is.
 */
export async function openStoredSecret(
  stored: string,
  cipher: SecretCipher | null,
  context: string,
): Promise<string> {
  if (!isSealed(stored)) return stored;
  if (cipher === null) {
    throw new SecretBoxError(
      "this record holds an encrypted secret but no encryption key is configured — set SECRET_ENCRYPTION_KEY",
    );
  }
  return cipher.open(stored, context);
}

/** Seals when a cipher is configured, and stores plaintext when one is not. See this module's header for why that is allowed. */
export async function sealStoredSecret(
  plaintext: string,
  cipher: SecretCipher | null,
  context: string,
): Promise<string> {
  return cipher === null ? plaintext : cipher.seal(plaintext, context);
}
