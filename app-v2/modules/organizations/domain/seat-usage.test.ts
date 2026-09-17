import { describe, expect, it } from "vitest";
import { countSeats, type SeatInvitation, type SeatMember } from "./seat-usage";

const NOW = new Date("2026-09-17T00:00:00Z");

function member(overrides: Partial<SeatMember> = {}): SeatMember {
  return {
    id: overrides.id ?? "member-1",
    status: overrides.status ?? "active",
    role: overrides.role ?? "member",
    isPlatformStaff: overrides.isPlatformStaff ?? false,
  };
}

function invitation(overrides: Partial<SeatInvitation> = {}): SeatInvitation {
  return {
    id: overrides.id ?? "invite-1",
    status: overrides.status ?? "pending",
    expiresAt: overrides.expiresAt === undefined ? null : overrides.expiresAt,
  };
}

describe("countSeats — SEAT_LIMITS.md §2 / §7", () => {
  it("counts an active member", () => {
    expect(countSeats([member({ status: "active" })], [], NOW)).toBe(1);
  });

  it("owner counts toward the cap the same as any other role", () => {
    const members = [
      member({ id: "1", role: "owner", status: "active" }),
      member({ id: "2", role: "member", status: "active" }),
    ];
    // A 3-seat plan is the owner plus two others, not owner-plus-three.
    expect(countSeats(members, [], NOW)).toBe(2);
  });

  it("does not count a removed or deactivated member", () => {
    const members = [
      member({ id: "1", status: "removed" }),
      member({ id: "2", status: "deactivated" }),
      member({ id: "3", status: "active" }),
    ];
    expect(countSeats(members, [], NOW)).toBe(1);
  });

  it("does not count Nexara platform staff even if flagged active", () => {
    const members = [member({ status: "active", isPlatformStaff: true })];
    expect(countSeats(members, [], NOW)).toBe(0);
  });

  it("pending invitations count toward usage", () => {
    const invitations = [invitation({ status: "pending" })];
    expect(countSeats([], invitations, NOW)).toBe(1);
  });

  it("an unbounded number of pending invitations each consume a seat (cap is not decorative)", () => {
    const invitations = Array.from({ length: 5 }, (_, i) => invitation({ id: `invite-${i}`, status: "pending" }));
    expect(countSeats([], invitations, NOW)).toBe(5);
  });

  it("expired invitations release their seat", () => {
    const invitations = [invitation({ status: "expired" })];
    expect(countSeats([], invitations, NOW)).toBe(0);
  });

  it("revoked invitations release their seat", () => {
    const invitations = [invitation({ status: "revoked" })];
    expect(countSeats([], invitations, NOW)).toBe(0);
  });

  it("accepted invitations do not double-count (the resulting member counts instead)", () => {
    const invitations = [invitation({ status: "accepted" })];
    expect(countSeats([], invitations, NOW)).toBe(0);
  });

  it("a pending invitation whose expiresAt has passed does not count, even if its status column has not caught up yet", () => {
    const invitations = [invitation({ status: "pending", expiresAt: new Date("2026-09-01T00:00:00Z") })];
    expect(countSeats([], invitations, NOW)).toBe(0);
  });

  it("a pending invitation whose expiresAt is in the future still counts", () => {
    const invitations = [invitation({ status: "pending", expiresAt: new Date("2026-10-01T00:00:00Z") })];
    expect(countSeats([], invitations, NOW)).toBe(1);
  });

  it("combines active members and pending invitations", () => {
    const members = [member({ id: "1" }), member({ id: "2", status: "removed" })];
    const invitations = [
      invitation({ id: "a", status: "pending" }),
      invitation({ id: "b", status: "expired" }),
    ];
    expect(countSeats(members, invitations, NOW)).toBe(2);
  });
});
