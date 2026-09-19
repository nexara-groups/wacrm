/**
 * The §3 code table from META_ERROR_TAXONOMY.md, as DATA.
 *
 * This is seed data for a `meta_error_codes` table (see spec §4) — editable
 * without a deploy once persisted. Here it is the in-memory default the
 * classifier falls back to. Every user-facing string is copied verbatim from
 * the spec; do not paraphrase or invent new layman copy here — edit the spec
 * first, then this file.
 *
 * `laymanMessage` is shown to end users: no Meta codes, no jargon.
 * `operatorHint` is for the account owner and the platform console — it MAY
 * reference the Meta code and Meta's own terminology, since that audience is
 * technical (spec §4b, "Two message fields, not one").
 */
import { Disposition } from "./disposition";

export interface MetaErrorCodeEntry {
  /** The Meta error `code`, as a string (Meta emits these as numbers, but we
   *  key by string to also allow the synthetic "NETWORK" and "UNKNOWN" keys). */
  readonly code: string;
  readonly disposition: Disposition;
  readonly laymanMessage: string;
  readonly operatorHint: string;
  /** Maximum number of automatic retry attempts. 0 for permanent dispositions. */
  readonly retryMax: number;
  /** Base delay (seconds) for the first retry; see domain/retry-policy.ts. */
  readonly retryBaseDelaySeconds: number;
}

// Retry tuning is not specified numerically in the spec beyond "unknown
// codes get a low cap (2)". These defaults are a deliberate, documented
// choice (see the SubagentHandback report for the full rationale):
//   - PERMANENT_* never retries (retryMax 0).
//   - THROTTLED backs off longer than TRANSIENT, since the failure means
//     "you are sending too fast", not "something briefly broke".
//   - TRANSIENT retries promptly a handful of times.
//   - UNKNOWN gets the spec-mandated retryMax of 2, at the TRANSIENT base
//     delay.
const NO_RETRY = { retryMax: 0, retryBaseDelaySeconds: 0 } as const;
const TRANSIENT_RETRY = { retryMax: 5, retryBaseDelaySeconds: 30 } as const;
const THROTTLED_RETRY = { retryMax: 5, retryBaseDelaySeconds: 60 } as const;
const UNKNOWN_RETRY = { retryMax: 2, retryBaseDelaySeconds: 30 } as const;

/**
 * PERMANENT_NUMBER — mark the contact, never retry.
 */
const PERMANENT_NUMBER_CODES: readonly MetaErrorCodeEntry[] = [
  {
    code: "131026",
    disposition: Disposition.PERMANENT_NUMBER,
    laymanMessage:
      "This number isn't on WhatsApp, or can't receive messages. We've stopped sending to it.",
    operatorHint:
      "Meta code 131026 (message undeliverable): the recipient is not reachable on WhatsApp. Contact has been suppressed.",
    ...NO_RETRY,
  },
  {
    code: "131021",
    disposition: Disposition.PERMANENT_NUMBER,
    laymanMessage: "This is your own WhatsApp number — you can't message yourself.",
    operatorHint:
      "Meta code 131021 (recipient cannot be sender): the recipient number matches the sending WABA number.",
    ...NO_RETRY,
  },
  {
    // See CODE_131009_PHONE_PARAMETER below for the full handling of this
    // code — it is dual-disposition and requires inspecting
    // `parameterName` (spec §3, footnote *). This entry is the
    // PERMANENT_NUMBER branch: the offending parameter is the recipient
    // phone number.
    code: "131009",
    disposition: Disposition.PERMANENT_NUMBER,
    laymanMessage: "This phone number isn't valid. Check the country code and format.",
    operatorHint:
      "Meta code 131009 (parameter value not valid) on the recipient phone number parameter: the number format/country code is invalid.",
    ...NO_RETRY,
  },
];

/**
 * The PERMANENT_CONFIG branch of 131009 — same Meta code, but the invalid
 * parameter is NOT the recipient phone number (e.g. a template variable).
 * Kept separate from the main table because a single `code` key cannot hold
 * two dispositions; see meta-error-classifier.ts for the branching logic.
 * Per spec: "when ambiguous, treat as PERMANENT_CONFIG (safer)".
 */
export const CODE_131009_GENERIC_PARAMETER: MetaErrorCodeEntry = {
  code: "131009",
  disposition: Disposition.PERMANENT_CONFIG,
  laymanMessage: "One of the values provided isn't valid. Check the details and try again.",
  operatorHint:
    "Meta code 131009 (parameter value not valid) on a non-phone parameter (or the parameter could not be determined): treat as a template/config problem, not a bad number.",
  ...NO_RETRY,
};

/**
 * PERMANENT_CONFIG — stop the run, alert the operator.
 */
const PERMANENT_CONFIG_CODES: readonly MetaErrorCodeEntry[] = [
  {
    code: "131047",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage:
      "It's been over 24 hours since this person last messaged you. Use an approved template to reach them.",
    operatorHint:
      "Meta code 131047 (re-engagement required): the 24-hour customer service window is closed; a template message is required.",
    ...NO_RETRY,
  },
  {
    code: "132001",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "This template isn't approved for the language you're sending in.",
    operatorHint:
      "Meta code 132001 (template does not exist): no approved template matches the requested name/language pair.",
    ...NO_RETRY,
  },
  {
    code: "132000",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "This template expects a different number of values than were provided.",
    operatorHint: "Meta code 132000 (parameter count mismatch): template variable count does not match the payload.",
    ...NO_RETRY,
  },
  {
    code: "132015",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "This template is paused because of poor quality ratings. Edit it or use a different one.",
    operatorHint: "Meta code 132015 (template paused): quality rating dropped; template is paused by Meta.",
    ...NO_RETRY,
  },
  {
    code: "132016",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "This template has been disabled by Meta and can't be used.",
    operatorHint: "Meta code 132016 (template disabled): template was disabled by Meta; it cannot be used until replaced.",
    ...NO_RETRY,
  },
  {
    code: "132012",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "One of the values in this template is in the wrong format.",
    operatorHint: "Meta code 132012 (parameter format mismatch): a template variable's value does not match the expected format.",
    ...NO_RETRY,
  },
  {
    code: "132005",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "The filled-in template message is too long to send.",
    operatorHint: "Meta code 132005 (hydrated text too long): the rendered message exceeds Meta's length limit.",
    ...NO_RETRY,
  },
  {
    code: "131031",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "Your WhatsApp Business account has been restricted by Meta. Check WhatsApp Manager.",
    operatorHint: "Meta code 131031 (business account restricted): the WABA is restricted; review WhatsApp Manager.",
    ...NO_RETRY,
  },
  {
    code: "131042",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "There's a billing problem on your WhatsApp Business account. Check your payment method with Meta.",
    operatorHint: "Meta code 131042 (business eligibility/payment issue): billing/eligibility problem on the WABA.",
    ...NO_RETRY,
  },
  {
    code: "133010",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "This WhatsApp number isn't registered yet. Finish setup before sending.",
    operatorHint: "Meta code 133010 (phone number not registered): the sending number has not completed Cloud API registration.",
    ...NO_RETRY,
  },
  {
    code: "190",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "Your WhatsApp connection has expired. Reconnect your account.",
    operatorHint: "Meta code 190 (access token expired/invalid): the stored access token is no longer valid; reconnect via OAuth.",
    ...NO_RETRY,
  },
  {
    code: "10",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "We don't have permission to do this. Reconnect your WhatsApp account.",
    operatorHint: "Meta code 10 (permission denied): the app/token lacks a required permission.",
    ...NO_RETRY,
  },
];

/**
 * THROTTLED — requeue with delay.
 *
 * 131049 is the spec's deliberate non-entry: Meta chose not to deliver for
 * ecosystem/marketing-frequency reasons. It is a per-user marketing-frequency
 * cap, NOT a bad number, so it MUST stay THROTTLED — see the regression
 * guard in meta-error-classifier.ts, which additionally enforces this
 * regardless of what this table says.
 */
const THROTTLED_CODES: readonly MetaErrorCodeEntry[] = [
  {
    code: "130429",
    disposition: Disposition.THROTTLED,
    laymanMessage: "Sending too fast — we'll slow down and keep going.",
    operatorHint: "Meta code 130429 (Cloud API throughput limit): sending rate exceeded the API's throughput cap.",
    ...THROTTLED_RETRY,
  },
  {
    code: "131048",
    disposition: Disposition.THROTTLED,
    laymanMessage: "Meta has temporarily limited your sending. We'll retry shortly.",
    operatorHint: "Meta code 131048 (spam rate limit): Meta detected spam-like sending behaviour and applied a temporary limit.",
    ...THROTTLED_RETRY,
  },
  {
    code: "131056",
    disposition: Disposition.THROTTLED,
    laymanMessage: "Too many messages to this contact right now. We'll retry shortly.",
    operatorHint: "Meta code 131056 (business/recipient pair rate limit): too many messages to this specific recipient in the window.",
    ...THROTTLED_RETRY,
  },
  {
    code: "4",
    disposition: Disposition.THROTTLED,
    laymanMessage: "We've hit a temporary limit. Sending will resume automatically.",
    operatorHint: "Meta code 4 (app-level too many calls): the app has exceeded its API call rate limit.",
    ...THROTTLED_RETRY,
  },
  {
    code: "80007",
    disposition: Disposition.THROTTLED,
    laymanMessage: "Your account's sending limit was reached. Sending resumes automatically.",
    operatorHint: "Meta code 80007 (WABA rate limit): the WhatsApp Business Account has reached its messaging rate limit.",
    ...THROTTLED_RETRY,
  },
  {
    code: "133016",
    disposition: Disposition.THROTTLED,
    laymanMessage: "Too many setup attempts. Wait a few minutes and try again.",
    operatorHint: "Meta code 133016 (register/deregister rate limit): too many phone number register/deregister calls.",
    ...THROTTLED_RETRY,
  },
  {
    code: "131049",
    disposition: Disposition.THROTTLED,
    laymanMessage: "Meta limited marketing messages to this person right now. We'll try again later.",
    operatorHint:
      "Meta code 131049 (healthy ecosystem / marketing frequency cap): Meta chose not to deliver a marketing message to protect the recipient's experience. This is NEVER a bad-number signal — do not suppress.",
    ...THROTTLED_RETRY,
  },
];

/**
 * TRANSIENT — retry with backoff.
 */
const TRANSIENT_CODES: readonly MetaErrorCodeEntry[] = [
  {
    code: "131000",
    disposition: Disposition.TRANSIENT,
    laymanMessage: "Something went wrong on WhatsApp's side. We'll try again.",
    operatorHint: "Meta code 131000 (generic error): no further detail provided by Meta.",
    ...TRANSIENT_RETRY,
  },
  {
    code: "131016",
    disposition: Disposition.TRANSIENT,
    laymanMessage: "WhatsApp is temporarily unavailable. We'll try again.",
    operatorHint: "Meta code 131016 (service unavailable): Meta-side service outage or degradation.",
    ...TRANSIENT_RETRY,
  },
  {
    code: "133004",
    disposition: Disposition.TRANSIENT,
    laymanMessage: "WhatsApp is temporarily unavailable. We'll try again.",
    operatorHint: "Meta code 133004 (server temporarily unavailable): Meta-side server unavailable.",
    ...TRANSIENT_RETRY,
  },
  {
    code: "131052",
    disposition: Disposition.TRANSIENT,
    laymanMessage: "We couldn't process the attached file. We'll try again.",
    operatorHint: "Meta code 131052 (media download error): Meta could not download the referenced media.",
    ...TRANSIENT_RETRY,
  },
  {
    code: "131053",
    disposition: Disposition.TRANSIENT,
    laymanMessage: "We couldn't process the attached file. We'll try again.",
    operatorHint: "Meta code 131053 (media upload error): Meta could not accept the uploaded media.",
    ...TRANSIENT_RETRY,
  },
  {
    code: "131057",
    disposition: Disposition.TRANSIENT,
    laymanMessage: "Your account is in maintenance mode. Sending resumes automatically.",
    operatorHint: "Meta code 131057 (account in maintenance mode): the WABA is temporarily in Meta-side maintenance.",
    ...TRANSIENT_RETRY,
  },
];

/** Synthetic entry for HTTP 5xx / network-level failures (no Meta `code`). */
export const NETWORK_ERROR_ENTRY: MetaErrorCodeEntry = {
  code: "NETWORK",
  disposition: Disposition.TRANSIENT,
  laymanMessage: "Connection problem. We'll try again.",
  operatorHint: "HTTP 5xx or a network-level failure talking to the Meta Cloud API; no Meta error payload was returned.",
  ...TRANSIENT_RETRY,
};

/** Synthetic entry for a code that isn't in this table at all. */
export const UNKNOWN_ERROR_ENTRY: MetaErrorCodeEntry = {
  code: "UNKNOWN",
  disposition: Disposition.TRANSIENT,
  laymanMessage: "Something went wrong sending this message. Our team has been notified.",
  operatorHint:
    "Unrecognised Meta error code — not present in the meta_error_codes table. Logged for review; treated as a low-cap transient retry. Never defaults to PERMANENT_NUMBER.",
  ...UNKNOWN_RETRY,
};

/**
 * The permission-denied RANGE, codes 200-299 (spec §3: "handle as a range,
 * not individual entries"). Deliberately not enumerated into 100 table rows.
 */
export const PERMISSION_DENIED_RANGE = {
  min: 200,
  max: 299,
  entry: {
    code: "200-299",
    disposition: Disposition.PERMANENT_CONFIG,
    laymanMessage: "We don't have permission to do this. Reconnect your WhatsApp account.",
    operatorHint: "Meta code in range 200-299 (permission denied family): the app/token lacks a required permission.",
    ...NO_RETRY,
  } satisfies MetaErrorCodeEntry,
} as const;

/**
 * The full seed table, keyed by Meta `code` (as a string). This is the
 * "seed data for a meta_error_codes table" the spec calls for.
 *
 * NOTE: does not include the 131009-generic-parameter variant (see
 * CODE_131009_GENERIC_PARAMETER above) or the 200-299 range (see
 * PERMISSION_DENIED_RANGE above) — both require logic beyond a single-code
 * lookup and are handled explicitly by the classifier.
 */
export const META_ERROR_CODES: Readonly<Record<string, MetaErrorCodeEntry>> = Object.freeze(
  Object.fromEntries(
    [
      ...PERMANENT_NUMBER_CODES,
      ...PERMANENT_CONFIG_CODES,
      ...THROTTLED_CODES,
      ...TRANSIENT_CODES,
    ].map((entry) => [entry.code, entry]),
  ),
);
