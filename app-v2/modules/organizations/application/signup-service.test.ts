import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH } from "@modules/identity/domain/password-policy";
import { SignupService } from "./signup-service";
import type { CreateTenantInput, CreateTenantResult, SignupRepository } from "./ports";

/**
 * In-memory fake for `SignupRepository`. Mirrors the real
 * `SqlSignupRepository`'s contract exactly: one call creates the whole
 * tenant, and a duplicate email returns `"email_taken"` rather than
 * throwing — this fake enforces global email uniqueness itself so a test
 * here can prove `SignupService` reacts to that outcome correctly without
 * touching a real database (that proof — atomicity against a REAL unique
 * index — lives in signup-repository.test.ts instead).
 */
class FakeSignupRepository implements SignupRepository {
  readonly createdTenants: CreateTenantInput[] = [];
  private readonly emails = new Set<string>();

  async createTenant(input: CreateTenantInput): Promise<CreateTenantResult> {
    if (this.emails.has(input.email)) return { kind: "email_taken" };
    this.emails.add(input.email);
    this.createdTenants.push(input);
    return { kind: "created" };
  }
}

function validInput(overrides: Partial<Parameters<SignupService["signup"]>[0]> = {}) {
  return {
    email: "owner@example.test",
    password: "correct-horse-battery-staple",
    accountName: "Acme Inc",
    ownerName: "Ada Owner",
    ...overrides,
  };
}

describe("SignupService", () => {
  it("creates a tenant with a server-generated id, never one supplied by the caller", async () => {
    const repository = new FakeSignupRepository();
    const service = new SignupService(repository);

    const outcome = await service.signup(validInput());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(repository.createdTenants).toHaveLength(1);
    const created = repository.createdTenants[0]!;
    expect(created.accountId).toBe(outcome.accountId);
    expect(created.ownerUserId).toBe(outcome.ownerUserId);
    // A UUID, not anything derived from request input.
    expect(created.accountId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.membershipId).not.toBe(created.accountId);
    expect(created.membershipId).not.toBe(created.ownerUserId);
  });

  it("hashes the password before it ever reaches the repository", async () => {
    const repository = new FakeSignupRepository();
    const service = new SignupService(repository);

    await service.signup(validInput({ password: "correct-horse-battery-staple" }));

    const created = repository.createdTenants[0]!;
    expect(created.passwordHash).not.toBe("correct-horse-battery-staple");
    expect(created.passwordHash.startsWith("pbkdf2-sha256$")).toBe(true);
  });

  it("normalizes the email (trim + lowercase) before creating the tenant", async () => {
    const repository = new FakeSignupRepository();
    const service = new SignupService(repository);

    const outcome = await service.signup(validInput({ email: "  Owner@Example.TEST  " }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.email).toBe("owner@example.test");
    expect(repository.createdTenants[0]?.email).toBe("owner@example.test");
  });

  it("refuses a password shorter than the policy minimum, and creates nothing", async () => {
    const repository = new FakeSignupRepository();
    const service = new SignupService(repository);

    const outcome = await service.signup(validInput({ password: "short1" }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.reason).toBe("weak_password");
    expect(outcome.message).toContain(String(MIN_PASSWORD_LENGTH));
    expect(repository.createdTenants).toHaveLength(0);
  });

  it("never calls the repository at all for a policy-rejected password", async () => {
    let calls = 0;
    const repository: SignupRepository = {
      createTenant: async () => {
        calls += 1;
        return { kind: "created" };
      },
    };
    const service = new SignupService(repository);

    await service.signup(validInput({ password: "too-short" }));

    expect(calls).toBe(0);
  });

  it("reports a friendly, non-throwing failure for a duplicate email", async () => {
    const repository = new FakeSignupRepository();
    const service = new SignupService(repository);

    const first = await service.signup(validInput({ email: "dup@example.test" }));
    expect(first.ok).toBe(true);

    const second = await service.signup(
      validInput({ email: "DUP@example.test", accountName: "A Different Company" }),
    );

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected failure");
    expect(second.reason).toBe("email_taken");
    expect(second.message.length).toBeGreaterThan(0);
    // Only the first signup's tenant exists.
    expect(repository.createdTenants).toHaveLength(1);
  });

  it("defaults to autoVerifyEmail: true when no options are given — preserves original behavior", async () => {
    const repository = new FakeSignupRepository();
    const service = new SignupService(repository);

    await service.signup(validInput());

    expect(repository.createdTenants[0]?.autoVerifyEmail).toBe(true);
  });

  it("forwards autoVerifyEmail: false to the repository when a real email provider can send the verification", async () => {
    const repository = new FakeSignupRepository();
    const service = new SignupService(repository);

    const outcome = await service.signup(validInput(), { autoVerifyEmail: false });

    expect(outcome.ok).toBe(true);
    expect(repository.createdTenants[0]?.autoVerifyEmail).toBe(false);
  });

  it("treats a missing owner name as absent, not an empty string", async () => {
    const repository = new FakeSignupRepository();
    const service = new SignupService(repository);

    await service.signup(validInput({ ownerName: undefined }));
    expect(repository.createdTenants[0]?.ownerName).toBeNull();

    await service.signup(validInput({ email: "second@example.test", ownerName: "   " }));
    expect(repository.createdTenants[1]?.ownerName).toBeNull();
  });
});
