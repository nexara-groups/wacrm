/**
 * Password policy — pure, and the only place that decides what a password
 * must look like.
 *
 * WHY THE MINIMUM IS 12 AND NOT 8. This deployment hashes with PBKDF2 at
 * 40,000 iterations rather than the OWASP-recommended 210,000, to fit
 * Cloudflare Workers' 10ms free-tier CPU budget (see
 * `WORKERS_FREE_TIER_ITERATIONS`). That makes each guess about five times
 * cheaper for an attacker who has stolen the credentials table.
 *
 * Length is the compensating control, and it is a far better lever than
 * iteration count: iterations multiply an attacker's cost by a constant,
 * while each additional character multiplies the search space. Four extra
 * characters buy vastly more than the 5x the iteration count gave up. Given
 * a choice between a stronger KDF and a longer minimum, the longer minimum
 * wins — and here we are not even choosing, the KDF ceiling is imposed by
 * the platform.
 *
 * WHY THERE IS A MAXIMUM. The password is fed to PBKDF2, so an unbounded
 * input is an unbounded allocation on a request path with a hard CPU and
 * memory budget. 256 characters is far beyond any real passphrase and well
 * short of anything that hurts.
 *
 * WHY NO COMPOSITION RULES (an uppercase, a digit, a symbol). They push
 * people toward `Password1!` — predictable substitutions that barely enlarge
 * the real search space while making passwords harder to remember, so they
 * get reused or written down. NIST SP 800-63B advises against mandated
 * composition rules for exactly this reason. Length, and nothing else.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export type PasswordRejection =
  | { readonly kind: "too_short"; readonly minLength: number }
  | { readonly kind: "too_long"; readonly maxLength: number }
  | { readonly kind: "blank" };

export type PasswordCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: PasswordRejection; readonly laymanMessage: string };

/**
 * Checks a password that is being SET. Deliberately NOT applied at login:
 * an existing password that predates a policy change must keep working, and
 * rejecting it at the door would lock people out of their own accounts to
 * enforce a rule they were never given a chance to satisfy. It would also
 * tell an attacker the policy for free.
 */
export function checkPassword(password: string): PasswordCheck {
  // Counted in code points, not UTF-16 units, so an emoji or an accented
  // character counts as the one character a person typed rather than two.
  const length = [...password].length;

  if (password.trim().length === 0) {
    return {
      ok: false,
      rejection: { kind: "blank" },
      laymanMessage: "Please enter a password.",
    };
  }
  if (length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      rejection: { kind: "too_short", minLength: MIN_PASSWORD_LENGTH },
      laymanMessage: `Please use at least ${MIN_PASSWORD_LENGTH} characters. A short phrase you'll remember is stronger than a short password.`,
    };
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      rejection: { kind: "too_long", maxLength: MAX_PASSWORD_LENGTH },
      laymanMessage: `Please use ${MAX_PASSWORD_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true };
}
