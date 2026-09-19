/** Invitations — invite, accept, revoke, list members (+ pending invitations). */
import type {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  InviteMemberRequest,
  InviteMemberResponse,
  ListMembersQuery,
  ListMembersResponse,
  RevokeInvitationRequest,
  RevokeInvitationResponse,
} from "@packages/contracts/src/index";
import {
  acceptInvitationResponseSchema,
  inviteMemberResponseSchema,
  listMembersResponseSchema,
  revokeInvitationResponseSchema,
} from "@packages/contracts/src/index";
import { apiRequest, type ApiClientContext, type SuccessOf } from "../http";
import type { ApiClientError } from "../errors";
import type { Result } from "../result";

export interface InvitationsResource {
  invite(request: InviteMemberRequest): Promise<Result<SuccessOf<InviteMemberResponse>, ApiClientError>>;
  accept(request: AcceptInvitationRequest): Promise<Result<SuccessOf<AcceptInvitationResponse>, ApiClientError>>;
  revoke(request: RevokeInvitationRequest): Promise<Result<SuccessOf<RevokeInvitationResponse>, ApiClientError>>;
  /** Active members AND pending invitations together — see `listMembersResponseSchema`'s header comment in contracts. */
  listMembers(query?: ListMembersQuery): Promise<Result<SuccessOf<ListMembersResponse>, ApiClientError>>;
}

export function createInvitationsResource(ctx: ApiClientContext): InvitationsResource {
  return {
    invite: (request) =>
      apiRequest(ctx, { method: "POST", path: "/invitations.invite", body: request }, inviteMemberResponseSchema),

    accept: (request) =>
      apiRequest(ctx, { method: "POST", path: "/invitations.accept", body: request }, acceptInvitationResponseSchema),

    revoke: (request) =>
      apiRequest(ctx, { method: "POST", path: "/invitations.revoke", body: request }, revokeInvitationResponseSchema),

    listMembers: (query) =>
      apiRequest(ctx, { method: "GET", path: "/invitations.listMembers", query }, listMembersResponseSchema),
  };
}
