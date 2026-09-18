/**
 * Small row-mapping helpers shared by the identity module's SQL repositories.
 * Mirrors `modules/contacts/infrastructure/contact-repository.ts`'s local
 * `text`/`nullableText` helpers, pulled out here once because five
 * repositories in this module need them instead of just one.
 */

export function text(value: unknown): string {
  return String(value);
}

export function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}
