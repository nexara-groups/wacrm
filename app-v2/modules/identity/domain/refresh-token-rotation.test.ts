import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "./token-hashing";
import {
  issueInitialRefreshToken,
  rotateRefreshToken,
  type NewRefreshTokenRecord,
  type RefreshTokenPort,
  type RefreshTokenRecord,
  type RotationDeps,
} from "./refresh-token-rotation";

/** In-memory fake of the refresh-token port, for pure domain-logic tests. */
class InMemoryRefreshTokenPort implements RefreshTokenPort {
  private readonly records = new Map<string, RefreshTokenRecord>();
  private nextId = 1;

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    for (const record of this.records.values()) {
      if (record.tokenHash === tokenHash) return record;
    }
    return null;
  }

  async findFamily(familyId: string): Promise<readonly RefreshTokenRecord[]> {
    return [...this.records.values()].filter((r) => r.familyId === familyId);
  }

  async insert(input: NewRefreshTokenRecord): Promise<RefreshTokenRecord> {
    const record: RefreshTokenRecord = {
      id: `rt_${this.nextId++}`,
      usedAt: null,
      revokedAt: null,
      ...input,
    };
    this.records.set(record.id, record);
    return record;
  }

  async markUsed(id: string, usedAt: string): Promise<void> {
    const existing = this.records.get(id);
    if (!existing) return;
    this.records.set(id, { ...existing, usedAt });
  }

  async revokeFamily(familyId: string, revokedAt: string): Promise<void> {
    for (const record of this.records.values()) {
      if (record.familyId === familyId && !record.revokedAt) {
        this.records.set(record.id, { ...record, revokedAt });
      }
    }
  }

  all(): RefreshTokenRecord[] {
    return [...this.records.values()];
  }
}

function makeDeps(port: RefreshTokenPort, clock: { now: Date }): RotationDeps {
  return {
    port,
    hashToken,
    generateToken: () => generateToken(),
    now: () => clock.now,
    ttlMs: 30 * 24 * 60 * 60 * 1000,
  };
}

describe("refresh-token-rotation", () => {
  it("issues a new token on rotation and invalidates the old one", async () => {
    const port = new InMemoryRefreshTokenPort();
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const deps = makeDeps(port, clock);

    const initial = await issueInitialRefreshToken(deps, "session-1");

    const result = await rotateRefreshToken(deps, initial.rawToken);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.rawToken).not.toBe(initial.rawToken);
    expect(result.value.record.familyId).toBe(initial.record.familyId);
    expect(result.value.record.rotatedFrom).toBe(initial.record.id);

    const oldRecord = port.all().find((r) => r.id === initial.record.id);
    expect(oldRecord?.usedAt).not.toBeNull();
    expect(oldRecord?.revokedAt).toBeNull();
  });

  it("rejects a refresh token that does not exist", async () => {
    const port = new InMemoryRefreshTokenPort();
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const deps = makeDeps(port, clock);

    const result = await rotateRefreshToken(deps, "totally-made-up-token");
    expect(result.ok).toBe(false);
  });

  it("rejects an expired refresh token", async () => {
    const port = new InMemoryRefreshTokenPort();
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const deps = makeDeps(port, clock);

    const initial = await issueInitialRefreshToken(deps, "session-1");
    clock.now = new Date(clock.now.getTime() + deps.ttlMs + 1000);

    const result = await rotateRefreshToken(deps, initial.rawToken);
    expect(result.ok).toBe(false);
  });

  describe("reuse detection", () => {
    it("replaying an already-rotated token revokes the WHOLE family (every token in it)", async () => {
      const port = new InMemoryRefreshTokenPort();
      const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
      const deps = makeDeps(port, clock);

      const r0 = await issueInitialRefreshToken(deps, "session-1");
      const rotate1 = await rotateRefreshToken(deps, r0.rawToken);
      expect(rotate1.ok).toBe(true);
      if (!rotate1.ok) return;
      const r1 = rotate1.value;

      const rotate2 = await rotateRefreshToken(deps, r1.rawToken);
      expect(rotate2.ok).toBe(true);
      if (!rotate2.ok) return;
      const r2 = rotate2.value;

      // Family now has 3 tokens: r0 (used), r1 (used), r2 (active, not yet used).
      const familyBefore = await port.findFamily(r0.record.familyId);
      expect(familyBefore).toHaveLength(3);
      expect(familyBefore.every((t) => t.revokedAt === null)).toBe(true);

      // An attacker replays r0 — the token the legitimate client already rotated past.
      const replay = await rotateRefreshToken(deps, r0.rawToken);
      expect(replay.ok).toBe(false);

      // Reuse detection must revoke every token in the family, not just r0.
      const familyAfter = await port.findFamily(r0.record.familyId);
      expect(familyAfter).toHaveLength(3);
      expect(familyAfter.every((t) => t.revokedAt !== null)).toBe(true);

      // The legitimate client's still-unused token (r2) is now dead too — this is
      // intentional: once reuse is detected the whole session line is untrusted.
      const legitimateAttempt = await rotateRefreshToken(deps, r2.rawToken);
      expect(legitimateAttempt.ok).toBe(false);
    });

    it("detects reuse across a longer chain: rotate 3 times, then replay the very first token", async () => {
      const port = new InMemoryRefreshTokenPort();
      const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
      const deps = makeDeps(port, clock);

      const r0 = await issueInitialRefreshToken(deps, "session-1");

      const rotate1 = await rotateRefreshToken(deps, r0.rawToken);
      if (!rotate1.ok) throw new Error("expected rotate1 to succeed");
      const rotate2 = await rotateRefreshToken(deps, rotate1.value.rawToken);
      if (!rotate2.ok) throw new Error("expected rotate2 to succeed");
      const rotate3 = await rotateRefreshToken(deps, rotate2.value.rawToken);
      if (!rotate3.ok) throw new Error("expected rotate3 to succeed");

      // Family now has 4 tokens (r0 + 3 rotations); only the last is unused.
      const familyBefore = await port.findFamily(r0.record.familyId);
      expect(familyBefore).toHaveLength(4);

      // Replay the very first token in the chain, long since rotated away from.
      const replay = await rotateRefreshToken(deps, r0.rawToken);
      expect(replay.ok).toBe(false);

      const familyAfter = await port.findFamily(r0.record.familyId);
      expect(familyAfter).toHaveLength(4);
      expect(familyAfter.every((t) => t.revokedAt !== null)).toBe(true);

      // The current, valid-looking end of the chain is also dead now.
      const currentAttempt = await rotateRefreshToken(deps, rotate3.value.rawToken);
      expect(currentAttempt.ok).toBe(false);
    });

    it("rejects replay of an already-revoked token without re-revoking (idempotent failure)", async () => {
      const port = new InMemoryRefreshTokenPort();
      const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
      const deps = makeDeps(port, clock);

      const r0 = await issueInitialRefreshToken(deps, "session-1");
      const rotate1 = await rotateRefreshToken(deps, r0.rawToken);
      if (!rotate1.ok) throw new Error("expected rotate1 to succeed");

      // First replay triggers reuse detection.
      await rotateRefreshToken(deps, r0.rawToken);
      // Second replay of the same already-used, already-revoked token still fails cleanly.
      const secondReplay = await rotateRefreshToken(deps, r0.rawToken);
      expect(secondReplay.ok).toBe(false);
    });
  });

  it("only hashes are ever persisted — no raw token value reaches the port", async () => {
    const port = new InMemoryRefreshTokenPort();
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const rawTokensIssued: string[] = [];
    const deps: RotationDeps = {
      port,
      hashToken,
      generateToken: () => {
        const raw = generateToken();
        rawTokensIssued.push(raw);
        return raw;
      },
      now: () => clock.now,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
    };

    const r0 = await issueInitialRefreshToken(deps, "session-1");
    const rotate1 = await rotateRefreshToken(deps, r0.rawToken);
    if (!rotate1.ok) throw new Error("expected rotate1 to succeed");
    await rotateRefreshToken(deps, rotate1.value.rawToken);

    expect(rawTokensIssued.length).toBeGreaterThanOrEqual(3);

    for (const record of port.all()) {
      for (const raw of rawTokensIssued) {
        expect(record.tokenHash).not.toBe(raw);
        expect(record.tokenHash).not.toContain(raw);
        // No field on the persisted record equals (or embeds) a raw token.
        for (const value of Object.values(record)) {
          if (typeof value === "string") {
            expect(value).not.toBe(raw);
          }
        }
      }
    }
  });
});
