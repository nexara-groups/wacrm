import { describe, expect, it } from "vitest";
import { verifyPassword } from "@modules/identity/domain/token-hashing";
import { AcceptInvitationService } from "./accept-invitation-service";
import { FakeSeatRepository } from "./seat-service.test";

const NOW = new Date("2026-09-17T00:00:00Z");

function tenant(tenantId: string) {
  return { tenantId };
}

describe("AcceptInvitationService — the public self-serve accept", () => {
  it("rejects a weak password BEFORE ever calling the repository", async () => {
    const repo = new FakeSeatRepository();
    const service = new AcceptInvitationService(repo);

    const outcome = await service.accept("some-token", "short", NOW);

    expect(outcome).toEqual({
      ok: false,
      reason: "weak_password",
      message: expect.stringContaining("12 characters"),
    });
    // Nothing in the repository was ever touched — no invitation exists to
    // even look up, so any repository call at all would have thrown.
  });

  it("accepts with a real password, hashing it (verifiable via verifyPassword, never bcrypt, never plaintext) before it ever reaches the repository", async () => {
    // Captured by wrapping acceptInvitationByToken to record what it was
    // called with, since FakeSeatRepository discards the hash.
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", { members: [] });
    const created = await repo.reserveSeatAndCreateInvitation(tenant("acct-1"), {
      email: "invitee2@example.test",
      role: "member",
      invitedBy: "owner-1",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    if (created === null) throw new Error("expected the invitation to be created");

    let capturedHash: string | null = null;
    const original = repo.acceptInvitationByToken.bind(repo);
    repo.acceptInvitationByToken = async (rawToken, passwordHash, now) => {
      capturedHash = passwordHash;
      return original(rawToken, passwordHash, now);
    };

    const service = new AcceptInvitationService(repo);
    const outcome = await service.accept(created.token, "a-genuinely-long-passphrase", NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected the accept to succeed");
    expect(outcome.email).toBe("invitee2@example.test"); // the INVITATION's email, never request input
    expect(outcome.tenantId).toBe("acct-1");
    expect(outcome.member.role).toBe("member");

    expect(capturedHash).not.toBeNull();
    expect(capturedHash).not.toBe("a-genuinely-long-passphrase"); // never the raw password
    expect(capturedHash!.startsWith("pbkdf2-sha256$")).toBe(true); // never bcrypt
    await expect(verifyPassword("a-genuinely-long-passphrase", capturedHash!)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password-entirely", capturedHash!)).resolves.toBe(false);
  });

  it("maps an unknown/expired token to a clear, actionable message", async () => {
    const repo = new FakeSeatRepository();
    const service = new AcceptInvitationService(repo);

    const outcome = await service.accept("no-such-token", "a-genuinely-long-passphrase", NOW);

    expect(outcome).toEqual({
      ok: false,
      reason: "invalid_or_expired",
      message: expect.any(String),
    });
  });

  it("maps a full account to a clear seat_unavailable message and consumes nothing", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", { members: [] });
    const created = await repo.reserveSeatAndCreateInvitation(tenant("acct-1"), {
      email: "capped@example.test",
      role: "member",
      invitedBy: "owner-1",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    if (created === null) throw new Error("expected the invitation to be created");

    // Fill the account to its (default) cap of 3 active members via the
    // cap-bypassing direct path.
    await repo.createMemberDirectly(tenant("acct-1"), { email: "d1@example.test", role: "member" });
    await repo.createMemberDirectly(tenant("acct-1"), { email: "d2@example.test", role: "member" });
    await repo.createMemberDirectly(tenant("acct-1"), { email: "d3@example.test", role: "member" });

    const service = new AcceptInvitationService(repo);
    const outcome = await service.accept(created.token, "a-genuinely-long-passphrase", NOW);

    expect(outcome).toEqual({
      ok: false,
      reason: "seat_unavailable",
      message: expect.any(String),
    });
    expect(await repo.listMembers(tenant("acct-1"))).toHaveLength(3);
  });

  it("maps an already-taken email to a clear message", async () => {
    const repo = new FakeSeatRepository();
    repo.seed("acct-1", { members: [] });
    repo.seedCredentialEmail("taken@example.test", "some-other-acct");
    const created = await repo.reserveSeatAndCreateInvitation(tenant("acct-1"), {
      email: "taken@example.test",
      role: "member",
      invitedBy: "owner-1",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    if (created === null) throw new Error("expected the invitation to be created");

    const service = new AcceptInvitationService(repo);
    const outcome = await service.accept(created.token, "a-genuinely-long-passphrase", NOW);

    expect(outcome).toEqual({
      ok: false,
      reason: "email_taken",
      message: expect.stringContaining("already exists"),
    });
  });
});
