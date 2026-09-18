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

export function internalError(error: unknown): NextResponse {
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
