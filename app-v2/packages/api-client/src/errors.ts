/**
 * The client-side error union. Every method on the client returns
 * `Result<T, ApiClientError>` (see `./result.ts`) — never throws for an
 * expected failure — and these three kinds are kept deliberately distinct
 * per the build brief: "A network failure and a 500 are different things;
 * do not collapse them."
 *
 *  - "network"  — `fetch()` itself rejected, or the response body could not
 *    be read at all. No HTTP response was received. Not the server's
 *    fault to describe; there IS no server answer to describe.
 *  - "http"     — an HTTP response WAS received and carries the shared
 *    `ErrorEnvelope` (`@packages/contracts`'s `errorEnvelopeSchema`), with
 *    both `laymanMessage` (customer-facing) and `operatorHint`
 *    (support/operator-facing) preserved verbatim — see
 *    META_ERROR_TAXONOMY.md §4b's "two message fields, not one" rule. This
 *    covers both a well-formed non-2xx error body AND the rarer case of a
 *    2xx response whose payload itself says `ok: false` (still an
 *    application-level failure, just not a transport-level one) — either
 *    way `status` carries the real HTTP status code observed.
 *  - "parse"    — a response (2xx or not) was received and read, but its
 *    body did NOT match the endpoint's zod response schema — including a
 *    non-2xx body that also fails to match the shared error envelope. This
 *    is the "fail loudly at the boundary" case the build brief calls out:
 *    a server returning the wrong shape must not silently become
 *    `undefined` three components deep.
 */
import type { ErrorEnvelope } from "@packages/contracts/src/index";

export interface ApiNetworkError {
  readonly kind: "network";
  readonly message: string;
  readonly cause: unknown;
}

export interface ApiHttpError {
  readonly kind: "http";
  readonly status: number;
  readonly error: ErrorEnvelope;
}

/** One zod validation issue, trimmed to the fields callers actually render/log. */
export interface ApiParseIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

export interface ApiParseError {
  readonly kind: "parse";
  readonly message: string;
  readonly issues: readonly ApiParseIssue[];
}

export type ApiClientError = ApiNetworkError | ApiHttpError | ApiParseError;

export function isNetworkError(error: ApiClientError): error is ApiNetworkError {
  return error.kind === "network";
}

export function isHttpError(error: ApiClientError): error is ApiHttpError {
  return error.kind === "http";
}

export function isParseError(error: ApiClientError): error is ApiParseError {
  return error.kind === "parse";
}
