/**
 * Disposition — META_ERROR_TAXONOMY.md §2. Every Meta/WhatsApp Cloud API
 * error classifies to exactly one of these. This is the vocabulary type
 * only; the actual code -> disposition classification table
 * (`meta_error_codes`, §3) is vendor-integration data owned by the
 * whatsapp/messaging module (it lives against `WhatsAppProvider`, per
 * §5 of the taxonomy doc) — out of scope for this framework-free package.
 */
export type Disposition = "TRANSIENT" | "THROTTLED" | "PERMANENT_NUMBER" | "PERMANENT_CONFIG";

export const DISPOSITIONS: readonly Disposition[] = [
  "TRANSIENT",
  "THROTTLED",
  "PERMANENT_NUMBER",
  "PERMANENT_CONFIG",
];

/** Only PERMANENT_NUMBER ever marks/suppresses the recipient's number (§2, §4). */
export function dispositionSuppressesNumber(disposition: Disposition): boolean {
  return disposition === "PERMANENT_NUMBER";
}

/** TRANSIENT and THROTTLED are retryable; the two PERMANENT_* dispositions are not (§2). */
export function dispositionIsRetryable(disposition: Disposition): boolean {
  return disposition === "TRANSIENT" || disposition === "THROTTLED";
}
