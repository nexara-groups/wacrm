/**
 * Auth wire contracts — self-serve signup. `apps/web/lib/auth-dto.ts`
 * already owns `loginRequestSchema`/`authUserSchema` (built before this
 * package's `modules/organizations` wiring existed); this file adds ONLY
 * the signup request/response, matching this package's existing pattern
 * (`invitations.ts`, `seats.ts`) — request in, `apiResult(...)` out, one
 * shared error envelope for every failure.
 *
 * Password shape is deliberately loose here (`z.string().min(1)`, same as
 * `loginRequestSchema`): the real policy (12-char minimum, no composition
 * rules) lives in `modules/identity/domain/password-policy.ts`, which this
 * zod-only, dependency-free package may not import (see this package's own
 * header rule: no runtime dependency beyond zod). A request that passes
 * this schema can still be refused server-side as `weak_password` — that
 * is expected, the same relationship `rawPhoneNumberInputSchema` documents
 * for phone numbers in `common/ids.ts`.
 */
import { z } from "zod";
import { accountIdSchema, userIdSchema } from "./common/ids";
import { apiResult } from "./common/response";

export const signupRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1, "Password is required"),
  /** The new tenant's display name — `accounts.name`, NOT NULL. */
  accountName: z.string().trim().min(1, "Business name is required").max(200),
  /** `users.display_name` — nullable in storage, so this is optional here too. */
  ownerName: z.string().trim().min(1).max(200).optional(),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const signupResponseSchema = apiResult({
  accountId: accountIdSchema,
  ownerUserId: userIdSchema,
  email: z.email(),
  /** Whether login will refuse this owner until they verify — follows
   * CAPABILITY (a real email provider configured), never a flag. */
  emailVerificationRequired: z.boolean(),
  /** Present only when `emailVerificationRequired` is true: whether the
   * verification email actually went out. */
  emailSent: z.boolean().optional(),
});
export type SignupResponse = z.infer<typeof signupResponseSchema>;

// ---------------------------------------------------------------------------
// Verify email — redeems the token from the emailed verification link. The
// token is the only input, same reasoning as `acceptInvitationRequestSchema`
// in invitations.ts: no client-supplied identity, holding the token is what
// authorizes this.
// ---------------------------------------------------------------------------

export const verifyEmailRequestSchema = z.object({ token: z.string().min(1) });
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

export const verifyEmailResponseSchema = apiResult({ email: z.email() });
export type VerifyEmailResponse = z.infer<typeof verifyEmailResponseSchema>;
