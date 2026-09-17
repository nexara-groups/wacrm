/** Return a normalized HTTPS URL, or null for malformed/non-HTTPS input. */
export function httpsUrlOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
