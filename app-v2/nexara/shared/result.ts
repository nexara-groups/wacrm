/**
 * Result<T, E> — a tiny, dependency-free way to return success/failure without
 * throwing across layer boundaries. Keeps business logic explicit about errors
 * and avoids leaking provider-specific exception types upward.
 */
export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}

// Imported here only for the default type parameter above.
import type { AppError } from "./errors";
