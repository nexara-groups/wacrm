/**
 * The four dispositions a Meta/WhatsApp Cloud API error (or a locally
 * detected failure such as a network error) can resolve to.
 *
 * See: docs/rebuild discussion/phase-0/META_ERROR_TAXONOMY.md §2.
 *
 *   TRANSIENT         Meta-side or network hiccup. Retry with backoff.
 *                      Never marks the contact.
 *   THROTTLED          Rate/quota limit hit. Retry with delay, respecting
 *                      the window. Never marks the contact.
 *   PERMANENT_NUMBER   This number cannot receive messages. Never retry.
 *                      Marks the contact (suppression) — per-contact fault.
 *   PERMANENT_CONFIG   Our account/template/token is misconfigured. Never
 *                      retry without a fix. Pause the run, alert the
 *                      operator — per-account fault, never per-contact.
 */
export const Disposition = {
  TRANSIENT: "TRANSIENT",
  THROTTLED: "THROTTLED",
  PERMANENT_NUMBER: "PERMANENT_NUMBER",
  PERMANENT_CONFIG: "PERMANENT_CONFIG",
} as const;

export type Disposition = (typeof Disposition)[keyof typeof Disposition];

/** All dispositions, for exhaustive iteration in tests and tooling. */
export const ALL_DISPOSITIONS: readonly Disposition[] = Object.values(Disposition);

/** True for dispositions that must never be retried automatically. */
export function isPermanent(disposition: Disposition): boolean {
  return (
    disposition === Disposition.PERMANENT_NUMBER ||
    disposition === Disposition.PERMANENT_CONFIG
  );
}

/** True only for the disposition that marks/suppresses the contact. */
export function marksContact(disposition: Disposition): boolean {
  return disposition === Disposition.PERMANENT_NUMBER;
}
