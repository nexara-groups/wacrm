/**
 * Response helpers shared by every route under `app/api/`.
 *
 * Every failure — validation, not-found, or unexpected — goes out through
 * `errorEnvelopeSchema` (`@packages/contracts`). No route may hand-roll an
 * error shape or leak a raw exception to the client.
 */
import { NextResponse } from "next/server";
import { ZodError, type z } from "zod";
import type { ErrorEnvelope } from "@packages/contracts/src/common/error-envelope";
import { AppError } from "@shared/errors";

export function ok<T extends Record<string, unknown>>(
  payload: T,
  init?: { status?: number },
): NextResponse {
  return NextResponse.json({ ok: true, ...payload }, { status: init?.status ?? 200 });
}

export function fail(error: ErrorEnvelope, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

/** A validation failure — request body/query didn't match its zod contract. */
export function validationError(error: ZodError): NextResponse {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_root";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fail(
    {
      code: "validation_error",
      laymanMessage: "That request wasn't quite right — check the highlighted fields.",
      fieldErrors,
    },
    400,
  );
}

export function notFoundError(resource: string): NextResponse {
  return fail(
    { code: "not_found", laymanMessage: `That ${resource} couldn't be found.` },
    404,
  );
}

/**
 * Maps the framework's `AppError` onto the right HTTP status.
 *
 * Without this, an `AppError.unauthenticated` thrown deep in a request —
 * which is exactly what `getContainer()` does when a session cookie is
 * present but no longer verifies (expired, or revoked at logout) — fell
 * through to `internalError` and went out as a 500. A stale session is a
 * completely ordinary event, not a server fault: reporting it as one tells
 * the client to retry, hides a real 500 among the noise, and leaks the
 * message as an `operatorHint`. The edge proxy only checks that a cookie is
 * PRESENT, so this is the path every expired session actually takes.
 */
const APP_ERROR_STATUS: Record<string, { status: number; code: string; laymanMessage: string }> = {
  UNAUTHENTICATED: {
    status: 401,
    code: "unauthenticated",
    laymanMessage: "Your session has expired. Please sign in again.",
  },
  FORBIDDEN: {
    status: 403,
    code: "forbidden",
    laymanMessage: "You don't have access to this.",
  },
  NOT_FOUND: {
    status: 404,
    code: "not_found",
    laymanMessage: "That couldn't be found.",
  },
  CONFLICT: {
    status: 409,
    code: "conflict",
    laymanMessage: "That conflicts with something that already exists.",
  },
  VALIDATION: {
    status: 400,
    code: "validation_error",
    laymanMessage: "That request wasn't quite right — check the highlighted fields.",
  },
};

export function internalError(error: unknown): NextResponse {
  if (error instanceof AppError) {
    const mapped = APP_ERROR_STATUS[error.code];
    if (mapped) {
      return fail(
        { code: mapped.code, laymanMessage: mapped.laymanMessage },
        mapped.status,
      );
    }
  }
  return fail(
    {
      code: "internal_error",
      laymanMessage: "Something went wrong on our end. Please try again.",
      operatorHint: error instanceof Error ? error.message : String(error),
    },
    500,
  );
}

/**
 * Parses `input` against `schema`; on failure throws the caught
 * `ZodError` so a route's single try/catch can turn it into
 * `validationError`. Never returns a value the caller has to
 * double-check — either you get validated data or an error response
 * has already been decided.
 */
export function parseOrThrow<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.infer<Schema> {
  return schema.parse(input);
}

export function isZodError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}
