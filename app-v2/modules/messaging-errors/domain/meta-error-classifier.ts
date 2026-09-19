/**
 * MetaErrorClassifier — domain-layer, vendor-free. Takes a parsed Meta error
 * envelope and returns a total classification. See spec §5: this must have
 * ZERO vendor SDK imports and is fully unit-testable in isolation.
 *
 * `classify` is total: every possible input (known code, unknown code,
 * range, network failure) produces a Classification. It never throws.
 */
import { Disposition } from "./disposition";
import {
  META_ERROR_CODES,
  CODE_131009_GENERIC_PARAMETER,
  NETWORK_ERROR_ENTRY,
  UNKNOWN_ERROR_ENTRY,
  PERMISSION_DENIED_RANGE,
  type MetaErrorCodeEntry,
} from "./meta-error-codes";

/**
 * Provider-agnostic error envelope. Whatever shape Meta's SDK/HTTP client
 * returns, the provider layer (outside this module) is responsible for
 * mapping it down to this before calling `classify`.
 */
export interface MetaError {
  /** Meta's numeric `code`, when present (e.g. 131026). */
  readonly code?: number;
  /** Meta's numeric `error_subcode`, when present. */
  readonly subcode?: number;
  /** Meta's raw developer message — never surface this to end users. */
  readonly message?: string;
  /** The name of the invalid parameter, when Meta's payload identifies one
   *  (used to disambiguate 131009 — see the classifier logic below). */
  readonly parameterName?: string;
  /** The HTTP status of the response, when the failure came from an HTTP
   *  call (used to detect 5xx as TRANSIENT even without a Meta `code`). */
  readonly httpStatus?: number;
  /** Set by the caller when the failure never reached Meta at all — a
   *  network-level error (timeout, DNS, connection reset, etc). */
  readonly isNetworkError?: boolean;
  /** The original, unmodified payload — kept for the audit log
   *  (`contact_delivery_events.raw_error`) and the operator's "technical
   *  details" disclosure. Never derive user-facing text from this
   *  directly; always go through the table. */
  readonly raw?: unknown;
}

export interface Classification {
  readonly disposition: Disposition;
  /** Customer-facing copy. Contains no Meta code and no raw Meta text. */
  readonly laymanMessage: string;
  /** Operator/support-facing copy. May reference the Meta code/terminology. */
  readonly operatorHint: string;
  readonly retryMax: number;
  readonly retryBaseDelaySeconds: number;
  /** The table key that produced this classification: a Meta code string,
   *  "200-299" for the permission range, "NETWORK", or "UNKNOWN". */
  readonly matchedKey: string;
}

/**
 * Parameter-name substrings (case-insensitive) that indicate the invalid
 * 131009 parameter IS the recipient's phone number. Anything not matching
 * one of these — including a missing `parameterName` altogether — is
 * treated as ambiguous and resolved to PERMANENT_CONFIG per spec ("when
 * ambiguous, choose PERMANENT_CONFIG (safer)").
 */
const PHONE_PARAMETER_NAME_HINTS: readonly string[] = [
  "to",
  "phone",
  "recipient",
  "wa_id",
  "waid",
  "msisdn",
];

function looksLikePhoneParameter(parameterName: string | undefined): boolean {
  if (!parameterName) return false;
  const normalized = parameterName.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return PHONE_PARAMETER_NAME_HINTS.some(
    (hint) => normalized === hint || normalized.includes(hint),
  );
}

function toClassification(entry: MetaErrorCodeEntry): Classification {
  return {
    disposition: entry.disposition,
    laymanMessage: entry.laymanMessage,
    operatorHint: entry.operatorHint,
    retryMax: entry.retryMax,
    retryBaseDelaySeconds: entry.retryBaseDelaySeconds,
    matchedKey: entry.code,
  };
}

/**
 * Classify a Meta/WhatsApp Cloud API error (or a locally-detected transport
 * failure) into a disposition plus user- and operator-facing copy.
 *
 * Resolution order:
 *   1. Network-level / HTTP 5xx (no Meta code reached us)  -> TRANSIENT
 *   2. 131009 special-case (phone-param vs generic)         -> table lookup
 *   3. 131049 explicit regression guard                     -> THROTTLED,
 *      always, independent of table contents
 *   4. 200-299 permission-denied RANGE                       -> range entry
 *   5. Exact code match in the seed table                    -> table entry
 *   6. Anything else (unrecognised code)                     -> UNKNOWN,
 *      always TRANSIENT with a capped retry — NEVER PERMANENT_NUMBER.
 *
 * 131049 carries an explicit regression guard (step 3) so that even a
 * corrupted/edited table can never turn Meta's marketing-frequency cap into
 * a number suppression — see META_ERROR_TAXONOMY.md, "The deliberate
 * non-entry".
 */
export function classify(error: MetaError): Classification {
  // 1. Network / HTTP 5xx — never a Meta error code at all.
  if (error.isNetworkError) {
    return toClassification(NETWORK_ERROR_ENTRY);
  }
  if (typeof error.httpStatus === "number" && error.httpStatus >= 500 && error.httpStatus < 600) {
    return toClassification(NETWORK_ERROR_ENTRY);
  }

  const code = error.code;
  if (code === undefined) {
    return toClassification(UNKNOWN_ERROR_ENTRY);
  }

  // 2. 131009 is dual-disposition: only PERMANENT_NUMBER when the invalid
  //    parameter is identifiably the recipient phone number.
  if (code === 131009) {
    if (looksLikePhoneParameter(error.parameterName)) {
      const entry = META_ERROR_CODES["131009"];
      // Table always seeds a 131009 entry (the phone-parameter variant);
      // this guard just satisfies the type checker without `as`.
      if (entry) return toClassification(entry);
    }
    return toClassification(CODE_131009_GENERIC_PARAMETER);
  }

  // 3. 131049 regression guard — must always resolve THROTTLED, never
  //    PERMANENT_NUMBER, independent of what the (editable) table says.
  if (code === 131049) {
    const entry = META_ERROR_CODES["131049"];
    if (entry && entry.disposition === Disposition.THROTTLED) {
      return toClassification(entry);
    }
    // Defensive fallback if the table were ever edited incorrectly: hold
    // the line on the documented plain-English copy rather than trust a
    // corrupted entry.
    return {
      disposition: Disposition.THROTTLED,
      laymanMessage: "Meta limited marketing messages to this person right now. We'll try again later.",
      operatorHint:
        "Meta code 131049 (healthy ecosystem / marketing frequency cap): forced to THROTTLED by classifier guard because the table entry was missing or incorrect.",
      retryMax: 5,
      retryBaseDelaySeconds: 60,
      matchedKey: "131049",
    };
  }

  // 4. Permission-denied RANGE, 200-299.
  if (code >= PERMISSION_DENIED_RANGE.min && code <= PERMISSION_DENIED_RANGE.max) {
    return toClassification(PERMISSION_DENIED_RANGE.entry);
  }

  // 5. Exact match in the seed table.
  const entry = META_ERROR_CODES[String(code)];
  if (entry) {
    return toClassification(entry);
  }

  // 6. Unrecognised code — always TRANSIENT, low retry cap, never suppress.
  return toClassification(UNKNOWN_ERROR_ENTRY);
}
