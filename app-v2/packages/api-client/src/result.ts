/**
 * Result<T, E> — mirrors the convention `nexara/shared/result.ts` sets for
 * this codebase (`{ ok: true, value } | { ok: false, error }`, plus
 * `ok`/`err`/`isOk`/`isErr` helpers). Reimplemented locally, byte-for-byte
 * compatible in shape, rather than imported: this package's only runtime
 * dependency is meant to be zod (+ `@packages/contracts`, its whole reason
 * to exist), and `nexara/shared/result.ts` — though itself tiny — sits
 * outside `packages/`, so importing it would put a live source edge from
 * `packages/api-client` onto `nexara/shared` the way `packages/contracts`
 * deliberately avoids doing onto `packages/domain` (see
 * `packages/contracts/src/common/vocab.ts`'s header comment for the same
 * reasoning applied one layer down). A consumer that already uses
 * `nexara/shared/result.ts`'s `isOk`/`isErr` can use this module's values
 * interchangeably — the shapes are identical by construction.
 */

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}
