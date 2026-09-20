/**
 * THE shared classification entry point — META_ERROR_TAXONOMY.md §5:
 * "Both paths must feed the same classifier — a design failure here is the
 * most likely way suppression silently does not work in production."
 *
 * Both `infrastructure/meta-whatsapp-provider.ts` (a send call's HTTP error
 * response) and `domain/webhook-parser.ts` (a `status.errors[]` entry on a
 * webhook-delivered `failed` status) build a `RawMetaErrorPayload` from
 * whatever shape they received, then call `classifyMetaFailure` — never
 * `classify` from `modules/messaging-errors` directly. That keeps the
 * "extract code/subcode/message/parameter, then classify" sequence in
 * exactly one place, so the two entry points cannot drift.
 *
 * Pure, vendor-free: no fetch, no SDK import. Domain layer per §5.
 */
import { classify, type Classification, type MetaError } from "@modules/messaging-errors/domain/meta-error-classifier";

/**
 * The union of shapes Meta actually sends an error in:
 *   - A send call's HTTP error body:      `{ error: { message, code, error_subcode, type, error_data } }`
 *   - A webhook `statuses[].errors[]` entry: `{ code, title, message, error_data }` (no `type`, "title" instead of nothing)
 * This type is the caller-normalised, already-unwrapped single-error object
 * (i.e. the `error` object, or one `errors[]` entry) — normalising which
 * envelope it came from is the caller's job; this module only cares about
 * the fields on ONE error.
 */
export interface RawMetaErrorPayload {
  readonly code?: number;
  readonly error_subcode?: number;
  readonly message?: string;
  /** Only present on the webhook `errors[]` shape. */
  readonly title?: string;
  readonly type?: string;
  readonly error_data?: {
    readonly details?: string;
    /** Not part of Meta's documented envelope today, but read defensively
     *  in case a future Cloud API version names the parameter explicitly
     *  — see `extractParameterName` below for the fallback heuristic used
     *  when it (as today) is absent. */
    readonly parameter?: string;
  };
  /** Set by the caller when the failure never reached Meta at all. */
  readonly httpStatus?: number;
  readonly isNetworkError?: boolean;
}

/**
 * Parameter-name substrings a 131009 "invalid parameter" error's free-text
 * `error_data.details` (or `message`) commonly contains when the offending
 * parameter is the recipient's phone number, e.g. `"Invalid parameter: to"`
 * or `"(#100) Invalid WhatsApp number provided"`. Meta's Cloud API does not
 * publish a structured `parameter_name` field as of this writing, so this
 * is a best-effort text scan — matches `meta-error-classifier.ts`'s own
 * `PHONE_PARAMETER_NAME_HINTS`, and per META_ERROR_TAXONOMY.md §3 footnote,
 * anything that does NOT match resolves to the safer PERMANENT_CONFIG
 * branch rather than risk wrongly suppressing a good number.
 */
const PARAMETER_NAME_PATTERNS: readonly RegExp[] = [
  /\bparameter\b[^a-zA-Z]{0,3}(?:name)?[:\s]+['"`]?([a-zA-Z_][a-zA-Z0-9_]*)/i,
  /\bfield\b[^a-zA-Z]{0,3}['"`]?([a-zA-Z_][a-zA-Z0-9_]*)/i,
  /\b(to|phone_number|phone|recipient|wa_id|waid|msisdn)\b/i,
];

/** Best-effort extraction of the offending parameter's name from Meta's
 *  free-text error fields. Returns `undefined` when nothing recognisable
 *  is found — `classify()` treats that as ambiguous (safe default). */
export function extractParameterName(payload: RawMetaErrorPayload): string | undefined {
  if (payload.error_data?.parameter) return payload.error_data.parameter;
  const haystack = `${payload.error_data?.details ?? ""} ${payload.message ?? ""}`.trim();
  if (haystack.length === 0) return undefined;
  for (const pattern of PARAMETER_NAME_PATTERNS) {
    const match = pattern.exec(haystack);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Maps ONE raw Meta error object (already unwrapped from whichever
 *  envelope it arrived in) to the `MetaError` shape `classify()` expects. */
export function toMetaError(payload: RawMetaErrorPayload): MetaError {
  return {
    code: payload.code,
    subcode: payload.error_subcode,
    message: payload.message ?? payload.title,
    parameterName: extractParameterName(payload),
    httpStatus: payload.httpStatus,
    isNetworkError: payload.isNetworkError,
    raw: payload,
  };
}

/**
 * THE function both entry points must call. Extracts + classifies in one
 * step so neither call site can accidentally skip a field or hand-roll its
 * own `MetaError`.
 */
export function classifyMetaFailure(payload: RawMetaErrorPayload): Classification {
  return classify(toMetaError(payload));
}

/** Convenience for building a `ProviderFailure` (see
 *  `domain/whatsapp-provider.interface.ts`) from a raw payload in one call. */
export function toProviderFailure(payload: RawMetaErrorPayload): {
  readonly metaError: MetaError;
  readonly classification: Classification;
} {
  const metaError = toMetaError(payload);
  return { metaError, classification: classify(metaError) };
}
