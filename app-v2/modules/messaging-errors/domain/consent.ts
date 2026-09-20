/**
 * Opt-out / DND — suppression that is not an error. See spec §3b.
 *
 * `consent_state` is a SEPARATE axis from `deliverability_state` (see
 * domain/suppression.ts): a contact can be technically reachable and opted
 * out at the same time. Both block sending, for different reasons, with
 * different reversal rules — opt-out is never clearable by an operator,
 * only by a fresh inbound message (or explicit re-opt-in) from the person
 * themselves.
 */
import { err, ok, type Result } from "@shared/result";
import { AppError } from "@shared/errors";

export type ConsentState = "unknown" | "opted_in" | "opted_out" | "do_not_contact";

/** Where an opt-out (or DND flag) originated. Kept for compliance evidence. */
export type OptOutSource =
  | "keyword"
  | "quick_reply"
  | "inferred_block"
  | "operator"
  | "import";

/**
 * Category scoping (opt out of marketing but still receive order updates)
 * is the correct long-term model, per spec §3b, but is explicitly deferred:
 * "Design the column to allow it; do not build it now." `"all"` is the only
 * value this module produces today.
 */
export type OptOutScope = "all";

export interface ConsentRecord {
  readonly state: ConsentState;
  readonly optedOutAt?: Date;
  readonly source?: OptOutSource;
  /** The inbound message id (or other durable reference) evidencing this
   *  state change — required for compliance disputes (spec §3b). */
  readonly evidence?: string;
  readonly scope: OptOutScope;
}

export const UNKNOWN_CONSENT: ConsentRecord = { state: "unknown", scope: "all" };

/**
 * Record an opt-out triggered by the person themselves (stop keyword, quick
 * reply, or an inferred block). This is always reachable going forward only
 * through `reOptIn` — there is deliberately no "clear by operator" function
 * in this module (spec §3b: "Opt-out is NOT clearable by any operator
 * role").
 */
export function optOut(
  source: Extract<OptOutSource, "keyword" | "quick_reply" | "inferred_block">,
  evidence: string,
  at: Date,
): ConsentRecord {
  return { state: "opted_out", optedOutAt: at, source, evidence, scope: "all" };
}

/**
 * Record an operator- or import-driven Do-Not-Contact flag. Distinct from
 * `optOut`: this is the business's own decision (e.g. a legal/compliance
 * hold), not the customer's expressed wish, but it still blocks sending and
 * is still not something a *different* operator action should silently
 * clear (use `clearDoNotContact` explicitly, with evidence).
 */
export function markDoNotContact(
  source: Extract<OptOutSource, "operator" | "import">,
  evidence: string | undefined,
  at: Date,
): ConsentRecord {
  return { state: "do_not_contact", optedOutAt: at, source, evidence, scope: "all" };
}

/**
 * The ONLY path back to `opted_in` from `opted_out`. Per spec §3b: "Only the
 * person" can reverse an opt-out, and "Re-opt-in must be evidenced (inbound
 * message id recorded)". `evidence` is therefore mandatory (not optional,
 * unlike elsewhere) and must be a durable reference to that inbound event —
 * never a bare boolean flip.
 *
 * This function does not accept a `source` of "operator": there is no
 * operator-triggered path in this module. Returns a Result because it is a
 * documented precondition violation — not a totally pure transform — when
 * called on a record that was never opted out; callers should still gate on
 * `consent.state === "opted_out"` before calling.
 */
export function reOptIn(current: ConsentRecord, evidence: string, at: Date): Result<ConsentRecord> {
  if (!evidence || evidence.trim().length === 0) {
    return err(AppError.validation("Re-opt-in requires evidence of a genuine inbound message"));
  }
  if (current.state !== "opted_out") {
    return err(
      AppError.validation(
        `Cannot re-opt-in from state "${current.state}" — re-opt-in only reverses an "opted_out" state`,
      ),
    );
  }
  return ok({ state: "opted_in", optedOutAt: undefined, source: undefined, evidence, scope: "all" });
}

/**
 * Clear a Do-Not-Contact flag. Unlike opt-out, this IS an operator action —
 * it is the business's own flag, not the customer's expressed wish — but it
 * still requires an explicit, evidenced call; it is never implicit.
 */
export function clearDoNotContact(current: ConsentRecord, evidence: string | undefined, at: Date): Result<ConsentRecord> {
  if (current.state !== "do_not_contact") {
    return err(
      AppError.validation(
        `Cannot clear do-not-contact from state "${current.state}" — it is not currently do_not_contact`,
      ),
    );
  }
  return ok({ state: "opted_in", optedOutAt: undefined, source: "operator", evidence, scope: "all" });
}

/** True when this consent state must block marketing/broadcast sends. */
export function blocksSend(state: ConsentState): boolean {
  return state === "opted_out" || state === "do_not_contact";
}

/**
 * Normalise text for stop-keyword matching: Unicode-normalise (so the same
 * word typed via different input methods compares equal), strip
 * Unicode-flagged diacritics and punctuation, collapse whitespace, and
 * lowercase. Applied identically to both the inbound message and each
 * configured keyword, so it works for any script (Latin, Devanagari,
 * Telugu, ...) — matching stays self-consistent even where "diacritic"
 * stripping is a no-op or overzealous for a given script, because both
 * sides of the comparison go through the same normalisation.
 */
export function normalizeForKeywordMatch(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\p{P}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Does `text` match any of the configured stop keywords? Keywords are
 * per-account, per-language, and passed in by the caller (spec §3b: "must
 * be per-account and per-language configurable, not a hardcoded English
 * list"). Matches when the whole normalised message equals a keyword, a
 * single-word keyword appears as a whole token, or a multi-word keyword
 * phrase appears in the normalised text.
 */
export function matchesStopKeyword(text: string, keywords: readonly string[]): boolean {
  const normalizedText = normalizeForKeywordMatch(text);
  if (normalizedText.length === 0) return false;
  const tokens = normalizedText.split(" ");

  for (const rawKeyword of keywords) {
    const keyword = normalizeForKeywordMatch(rawKeyword);
    if (keyword.length === 0) continue;
    if (normalizedText === keyword) return true;
    if (keyword.includes(" ")) {
      if (normalizedText.includes(keyword)) return true;
    } else if (tokens.includes(keyword)) {
      return true;
    }
  }
  return false;
}
