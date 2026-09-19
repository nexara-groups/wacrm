import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "./token-hashing";
import {
  consumeEmailToken,
  issueEmailToken,
  type EmailTokenDeps,
  type EmailTokenPort,
  type EmailTokenRecord,
  type NewEmailTokenRecord,
} from "./email-tokens";

class InMemoryEmailTokenPort implements EmailTokenPort {
  private readonly records = new Map<string, EmailTokenRecord>();
  private nextId = 1;

  async insert(input: NewEmailTokenRecord): Promise<EmailTokenRecord> {
    const record: EmailTokenRecord = { id: `et_${this.nextId++}`, consumedAt: null, ...input };
    this.records.set(record.id, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<EmailTokenRecord | null> {
    for (const record of this.records.values()) {
      if (record.tokenHash === tokenHash) return record;
    }
    return null;
  }

  async markConsumed(id: string, consumedAt: string): Promise<void> {
    const existing = this.records.get(id);
    if (!existing) return;
    this.records.set(id, { ...existing, consumedAt });
  }

  all(): EmailTokenRecord[] {
    return [...this.records.values()];
  }
}

function makeDeps(port: EmailTokenPort, clock: { now: Date }): EmailTokenDeps {
  return { port, hashToken, generateToken: () => generateToken(), now: () => clock.now };
}

describe("email-tokens", () => {
  it("issues a token and lets it be consumed exactly once", async () => {
    const port = new InMemoryEmailTokenPort();
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const deps = makeDeps(port, clock);

    const issued = await issueEmailToken(deps, "user-1", "reset");
    const first = await consumeEmailToken(deps, issued.rawToken, "reset");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.userId).toBe("user-1");
  });

  it("rejects a second consumption of an already-used token", async () => {
    const port = new InMemoryEmailTokenPort();
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const deps = makeDeps(port, clock);

    const issued = await issueEmailToken(deps, "user-1", "verify");
    const first = await consumeEmailToken(deps, issued.rawToken, "verify");
    expect(first.ok).toBe(true);

    const second = await consumeEmailToken(deps, issued.rawToken, "verify");
    expect(second.ok).toBe(false);
  });

  it("rejects an expired token even though it was never consumed", async () => {
    const port = new InMemoryEmailTokenPort();
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const deps = makeDeps(port, clock);

    const issued = await issueEmailToken(deps, "user-1", "invite", 60_000); // 1 minute TTL
    clock.now = new Date(clock.now.getTime() + 61_000);

    const result = await consumeEmailToken(deps, issued.rawToken, "invite");
    expect(result.ok).toBe(false);

    const stored = port.all().find((r) => r.id === issued.record.id);
    expect(stored?.consumedAt).toBeNull(); // never actually consumed, just expired
  });

  it("rejects a token presented against the wrong flow type", async () => {
    const port = new InMemoryEmailTokenPort();
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const deps = makeDeps(port, clock);

    const issued = await issueEmailToken(deps, "user-1", "reset");
    const result = await consumeEmailToken(deps, issued.rawToken, "verify");
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown/garbage token", async () => {
    const port = new InMemoryEmailTokenPort();
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const deps = makeDeps(port, clock);

    const result = await consumeEmailToken(deps, "not-a-real-token", "reset");
    expect(result.ok).toBe(false);
  });

  it("stores only the token hash, never the raw token", async () => {
    const port = new InMemoryEmailTokenPort();
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const deps = makeDeps(port, clock);

    const issued = await issueEmailToken(deps, "user-1", "reset");
    for (const record of port.all()) {
      expect(record.tokenHash).not.toBe(issued.rawToken);
      expect(record.tokenHash).not.toContain(issued.rawToken);
    }
  });
});
