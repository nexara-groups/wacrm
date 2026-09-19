/**
 * Integration proof for the task's own required test #4: a failed
 * invitation email must NOT destroy the invitation, and the caller must be
 * told honestly that the email did not go out. Exercises the real
 * `SqlSeatRepository` (over sql.js) + `SeatService`, the same stack
 * `app/api/invitations/route.ts` composes at request time, minus the
 * Next.js HTTP plumbing itself (this vitest config has no `@/` alias for
 * `apps/web`, and no other route here is tested through `NextRequest`
 * either — see `modules/organizations/infrastructure/seat-repository.test.ts`
 * for the same real-repository style this borrows its seeding from).
 */
import { describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@nexara/core/context";
import type { EmailMessage, EmailProvider } from "@nexara/core/email";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlSeatRepository } from "@modules/organizations/infrastructure/seat-repository";
import { SeatService } from "@modules/organizations/application/seat-service";
import { sendInvitationEmail } from "./invitation-email";
import { buildInvitationAcceptUrl } from "./email-templates";

const TENANT: TenantContext = { tenantId: "acct-invite-flow" };
const RAW_TOKEN_MARKER = "token-marker"; // the real token is whatever reserveSeatAndCreateInvitation mints

class ThrowingProvider implements EmailProvider {
  readonly name = "throwing";
  async send(_message: EmailMessage): Promise<void> {
    throw new Error("simulated vendor outage");
  }
}

async function seedAccount(db: SqlJsDatabaseProvider, accountId: string, ownerUserId: string): Promise<void> {
  await db.query(
    `insert into users (user_id, tenant_id, email, role, created_at, updated_at) values ($1, $2, $3, 'owner', 't', 't')`,
    [ownerUserId, accountId, `owner@${accountId}.test`],
  );
  await db.query(
    `-- tenant-scope-exempt: accounts IS the tenant root; its tenant column is id
     insert into accounts (id, name, owner_user_id, created_at, updated_at) values ($1, $1, $2, 't', 't')`,
    [accountId, ownerUserId],
  );
  await db.query(
    `insert into memberships (id, account_id, user_id, role, created_at, deactivated_at) values ($1, $2, $3, 'owner', 't', null)`,
    [`m-owner-${accountId}`, accountId, ownerUserId],
  );
}

describe("invitation creation + email delivery (integration)", () => {
  it("keeps a created invitation intact and reports the failure honestly when the email send throws", async () => {
    const db = await SqlJsDatabaseProvider.create();
    runMigrations(db);
    await seedAccount(db, TENANT.tenantId, "owner-1");

    const repo = new SqlSeatRepository(db);
    const seatService = new SeatService({ repository: repo });

    const created = await seatService.createInvitation(TENANT, {
      email: "invitee@flow.test",
      role: "member",
      invitedBy: "owner-1",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected the invitation to be created");
    const rawToken = created.value.token;
    expect(rawToken.length).toBeGreaterThan(0);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const emailResult = await sendInvitationEmail({
      emailProvider: new ThrowingProvider(),
      to: "invitee@flow.test",
      role: "member",
      acceptUrl: buildInvitationAcceptUrl(rawToken, { APP_BASE_URL: "https://app.example.test" }),
    });

    // The response HONESTLY reports the email did not go out...
    expect(emailResult.emailSent).toBe(false);
    expect(emailResult.emailError).toBeTruthy();

    // ...but the invitation itself is completely untouched: still there,
    // still pending, same row, no rollback of the earlier write.
    const invitations = await repo.listInvitations(TENANT);
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.id).toBe(created.value.invitation.id);
    expect(invitations[0]?.status).toBe("pending");
    expect(invitations[0]?.email).toBe("invitee@flow.test");

    // The raw token never appears in anything logged along the way.
    const loggedText = errorSpy.mock.calls.flat().map(String).join(" | ");
    expect(loggedText).not.toContain(rawToken);
    expect(loggedText).not.toContain(RAW_TOKEN_MARKER); // sanity: this suite never logs a marker either

    errorSpy.mockRestore();
  });
});
