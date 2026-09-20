import { getContainer } from "@/lib/container";
import { buildSeatUsageDTO, toAccountMemberDTO, toListedInvitationDTO } from "@/lib/seat-dto";
import { TeamScreen, type TeamScreenInitial } from "@/components/team/team-screen";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Same reason as app/contacts/page.tsx: the in-memory sql.js database is
// process-lived (lib/container.ts), so this page must never be statically
// prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * Server Component: reads seat usage + the first page of members/invitations
 * straight through the real repositories (no HTTP round trip for the
 * initial paint), then hands it to the client screen, which drives
 * invite/remove/revoke actions over `/api/seats`, `/api/members` and
 * `/api/invitations` from there on.
 */
export default async function TeamSettingsPage() {
  const { repositories, tenant } = await getContainer();

  const [config, members, invitations] = await Promise.all([
    repositories.seats.getSeatLimitConfig(tenant),
    repositories.seats.listMembers(tenant),
    repositories.seats.listInvitations(tenant),
  ]);

  const now = new Date();
  const { usage, limitSource } = buildSeatUsageDTO(tenant.tenantId, config, members, invitations, now);

  const initial: TeamScreenInitial = {
    usage,
    limitSource,
    members: {
      items: members.map((member) => toAccountMemberDTO(tenant.tenantId, member)),
      pagination: {
        page: 1,
        pageSize: members.length || 1,
        total: members.length,
        totalPages: 1,
        from: members.length > 0 ? 1 : 0,
        to: members.length,
        hasPrevious: false,
        hasNext: false,
      },
      pendingInvitations: invitations
        .filter((invitation) => invitation.status === "pending")
        .map((invitation) => {
          const createdAtFallback = invitation.expiresAt
            ? new Date(invitation.expiresAt.getTime() - INVITATION_TTL_MS).toISOString()
            : now.toISOString();
          return toListedInvitationDTO(tenant.tenantId, invitation, createdAtFallback);
        }),
    },
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <TeamScreen initial={initial} />
    </main>
  );
}
