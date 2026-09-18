/**
 * Invitations — invite, accept, revoke, list members.
 *
 * SEAT_LIMITS.md §3: invitations must be re-checked against the seat cap
 * both at creation AND at acceptance ("the cap may have been reduced, or
 * another invite accepted first"); both actions can fail with a seat-limit
 * error, which reuses the shared error envelope (never a bespoke shape) so
 * the UI renders SEAT_LIMITS.md §3's plain-English messages the same way
 * any other failure renders its `laymanMessage`.
 */
import { z } from "zod";
import { accountIdSchema, isoDateTimeSchema, opaqueIdSchema, userIdSchema } from "./common/ids";
import { apiResult } from "./common/response";
import { paginatedResponseSchema, paginationQuerySchema } from "./common/pagination";
import { invitableRoleSchema, roleSchema } from "./common/vocab";

// ---------------------------------------------------------------------------
// Invitation resource — SEAT_LIMITS.md §1 `account_invitations` (token
// hash, role, expiry). The token ITSELF is never returned in any response
// schema here — only its opaque row id — it is delivered out of band (the
// invite email), matching "token hash" in the spec's own data model (a
// server that could read the raw token back out of an API response
// wouldn't need to hash it).
// ---------------------------------------------------------------------------

export const invitationStatusSchema = z.enum(["pending", "accepted", "expired", "revoked"]);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationSchema = z.object({
  id: opaqueIdSchema,
  accountId: accountIdSchema,
  /**
   * Nullable because `account_invitations.label`, where the address lives,
   * is nullable. A non-null contract here forced the mapping layer to
   * invent an address for any row without one, which put fabricated
   * addresses on a team screen where they were indistinguishable from real
   * ones. A missing address should look missing.
   */
  email: z.email().nullable(),
  role: invitableRoleSchema,
  status: invitationStatusSchema,
  /** Nullable for the same reason: `created_by_user_id` is nullable. */
  invitedBy: userIdSchema.nullable(),
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
});
export type Invitation = z.infer<typeof invitationSchema>;

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

export const inviteMemberRequestSchema = z.object({
  email: z.email(),
  role: invitableRoleSchema,
});
export type InviteMemberRequest = z.infer<typeof inviteMemberRequestSchema>;

export const inviteMemberResponseSchema = apiResult({ invitation: invitationSchema });
export type InviteMemberResponse = z.infer<typeof inviteMemberResponseSchema>;

// ---------------------------------------------------------------------------
// Accept — the token is the ONLY input; the accepting user's identity comes
// from their authenticated session, not the request body, so a token can
// never be redeemed on someone else's behalf by a client-supplied user id.
// ---------------------------------------------------------------------------

export const acceptInvitationRequestSchema = z.object({ token: z.string().min(1) });
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

export const accountMemberSchema = z.object({
  userId: userIdSchema,
  accountId: accountIdSchema,
  role: roleSchema,
  status: z.enum(["active", "removed", "deactivated"]),
  joinedAt: isoDateTimeSchema,
});
export type AccountMember = z.infer<typeof accountMemberSchema>;

export const acceptInvitationResponseSchema = apiResult({ member: accountMemberSchema });
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>;

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

export const revokeInvitationRequestSchema = z.object({ invitationId: opaqueIdSchema });
export type RevokeInvitationRequest = z.infer<typeof revokeInvitationRequestSchema>;

export const revokeInvitationResponseSchema = apiResult({});
export type RevokeInvitationResponse = z.infer<typeof revokeInvitationResponseSchema>;

// ---------------------------------------------------------------------------
// List members — active members AND pending invitations together, since
// SEAT_LIMITS.md §2 treats them as one "who's using a seat" list ("Pending
// invites consuming seats" §3) even though they are different row shapes.
// ---------------------------------------------------------------------------

export const listMembersQuerySchema = paginationQuerySchema;
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;

export const listMembersResponseSchema = apiResult({
  ...paginatedResponseSchema(accountMemberSchema).shape,
  pendingInvitations: z.array(invitationSchema),
});
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;
