/**
 * The one place a request actually goes over the wire. Every resource
 * method in `./resources/*` funnels through `apiRequest()` so "parse
 * through zod, never cast" and "preserve both error-envelope fields" are
 * mechanical, not a convention each method has to remember (the same
 * motivation `apiResult()` gives in `@packages/contracts`).
 */
import type { z } from "zod";
import type { ErrorEnvelope } from "@packages/contracts/src/index";
import type { ApiClientError } from "./errors";
import { err, ok, type Result } from "./result";

/** The shape every `fetch` looks like — matches `globalThis.fetch`'s signature so a Worker/RN fetch or a test double both satisfy it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientContext {
  readonly baseUrl: string;
  readonly fetchFn: FetchLike;
  /** Merged into every request's headers; per-request headers (e.g. `Content-Type`) win on conflict. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A query-string-safe primitive value.
 *
 * `false` serialises as the string `"false"` and means what it says. That
 * is only true because the contracts side stopped using
 * `z.coerce.boolean()` for query flags: zod's coercion is `Boolean(value)`,
 * and `Boolean("false")` is `true`, so a coerced-boolean field could
 * express "true" and "absent" but never "false" — and got the one
 * remaining case exactly backwards. This client used to omit `false`
 * entirely to stay out of that trap. `booleanQueryFlagSchema`
 * (`@packages/contracts`) fixed it at the source, so the workaround is
 * gone and an explicit `false` now survives the round trip.
 */
export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>;

/**
 * Takes `object` rather than `QueryParams` on purpose: every caller passes
 * a contracts-inferred `*Query` type (e.g. `ListContactsQuery`), which —
 * being a plain interface-shaped object with no index signature of its
 * own — is not structurally assignable to a `Record<string, ...>` target
 * (TS2345 "Index signature for type 'string' is missing"). `object` has no
 * such requirement, so every real `*Query` type is accepted, and the
 * values are inspected at runtime instead: anything that is not a
 * string/number/boolean/array-of-those is silently skipped rather than
 * stringified into nonsense.
 */
export function buildQueryString(params?: object): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params as Record<string, unknown>)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

export interface RequestInput {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: object;
  /** JSON-serialisable request body. Sent as-is — request payloads are already exactly-typed by the contract's inferred `*Request`/`*Query` types, so there is nothing this package need re-validate on the way out (only responses are parsed defensively; see the package header). */
  readonly body?: unknown;
}

/** The success-payload shape of an `apiResult(...)`-wrapped response type, with the `ok` discriminant stripped. */
export type SuccessOf<Response extends { ok: boolean }> = Omit<Extract<Response, { ok: true }>, "ok">;

function synthesizeErrorEnvelope(response: Response, json: unknown): ErrorEnvelope {
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const nested =
    typeof record["error"] === "object" && record["error"] !== null
      ? (record["error"] as Record<string, unknown>)
      : undefined;
  const laymanMessage =
    (typeof nested?.["laymanMessage"] === "string" && nested["laymanMessage"]) ||
    (typeof record["message"] === "string" && record["message"]) ||
    "Something went wrong. Please try again.";
  const code =
    (typeof nested?.["code"] === "string" && nested["code"]) ||
    (typeof record["code"] === "string" && record["code"]) ||
    `HTTP_${response.status}`;
  return {
    code,
    laymanMessage,
    operatorHint: `Server responded ${response.status} ${response.statusText} with a body that did not match the expected shape.`,
  };
}

/**
 * Issues a request and parses the response through `responseSchema` —
 * never casts. `responseSchema` is expected to be an `apiResult(...)`
 * discriminated union (every `@packages/contracts` response schema is),
 * so a successful parse always tells us definitively whether the call
 * succeeded (`ok: true`) or failed at the application level (`ok: false`,
 * carrying the shared `ErrorEnvelope`) — independent of the HTTP status
 * actually used to transport it.
 */
export async function apiRequest<ResSchema extends z.ZodType<{ ok: boolean }>>(
  ctx: ApiClientContext,
  input: RequestInput,
  responseSchema: ResSchema,
): Promise<Result<SuccessOf<z.infer<ResSchema>>, ApiClientError>> {
  const url = `${ctx.baseUrl}${input.path}${buildQueryString(input.query)}`;
  const hasBody = input.body !== undefined;
  const requestInit: RequestInit = {
    method: input.method,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...ctx.headers,
    },
    ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
  };

  let response: Response;
  try {
    response = await ctx.fetchFn(url, requestInit);
  } catch (cause) {
    return err({
      kind: "network",
      message: cause instanceof Error ? cause.message : "Network request failed",
      cause,
    });
  }

  let rawText: string;
  try {
    rawText = await response.text();
  } catch (cause) {
    return err({
      kind: "network",
      message: cause instanceof Error ? cause.message : "Failed to read the response body",
      cause,
    });
  }

  let json: unknown;
  let bodyIsValidJson = true;
  try {
    json = rawText.length > 0 ? JSON.parse(rawText) : undefined;
  } catch {
    bodyIsValidJson = false;
  }

  if (!bodyIsValidJson) {
    if (!response.ok) {
      return err({ kind: "http", status: response.status, error: synthesizeErrorEnvelope(response, undefined) });
    }
    return err({
      kind: "parse",
      message: "Response was not valid JSON",
      issues: [],
    });
  }

  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    if (!response.ok) {
      return err({ kind: "http", status: response.status, error: synthesizeErrorEnvelope(response, json) });
    }
    return err({
      kind: "parse",
      message: "Response did not match the expected shape",
      issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }

  const data = parsed.data as { ok: boolean } & Record<string, unknown>;
  if (data["ok"] === false) {
    const envelope = data["error"] as ErrorEnvelope;
    return err({ kind: "http", status: response.status, error: envelope });
  }

  const { ok: _discriminant, ...rest } = data;
  return ok(rest as SuccessOf<z.infer<ResSchema>>);
}
