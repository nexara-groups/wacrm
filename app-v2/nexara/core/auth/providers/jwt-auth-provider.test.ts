import { describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../../db/sqlite/run-migrations";
import { SqlCredentialsRepository } from "../../../infrastructure/repositories/sql-credentials-repository";
import { PermissionService } from "../../rbac/permission-service";
import { JwtAuthProvider } from "./jwt-auth-provider";
import { hashPassword } from "@modules/identity/domain/token-hashing";

/**
 * There were NO tests for this class, which is the component that decides who
 * a request belongs to. These cover the property that matters most now that
 * one deployment serves every tenant: a session belongs to the tenant it was
 * issued for, and cannot be made to resolve inside another.
 *
 * Run against the real migrated schema and the real SQL repository — a mock
 * would happily agree with whatever the provider does, including a
 * cross-tenant lookup.
 */
const SECRET = "0".repeat(64);
const TENANT_A = "acct-aaaa";
const TENANT_B = "acct-bbbb";
const PASSWORD = "correct horse battery staple";

async function harness(configuredTenant: string) {
  const db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  const credentials = new SqlCredentialsRepository(db);
  const provider = new JwtAuthProvider(
    {
      secret: SECRET,
      tenantId: configuredTenant,
      issuer: "test-issuer",
      audience: "test-audience",
      // Kept low so the suite stays fast; production uses the free-tier value.
      passwordIterations: 1_000,
    },
    credentials,
    new PermissionService(),
  );
  return { db, credentials, provider };
}

async function seedUser(
  credentials: SqlCredentialsRepository,
  tenantId: string,
  userId: string,
  email: string,
  role: "owner" | "member" = "owner",
) {
  await credentials.create({ tenantId } as never, {
    userId,
    email,
    passwordHash: await hashPassword(PASSWORD, 1_000),
    role,
    verifiedAt: new Date().toISOString(),
  } as never);
}

describe("JwtAuthProvider — multi-tenant identity", () => {
  it("resolves the tenant from the credential, not from its own configuration", async () => {
    // The provider is configured with TENANT_A, but the user lives in
    // TENANT_B. Before login resolved the tenant from the credential this
    // returned "invalid email or password" — the user simply could not log in
    // to a deployment that named a different tenant, which is what limited
    // the product to one tenant per deployment.
    const { db, credentials, provider } = await harness(TENANT_A);
    await seedUser(credentials, TENANT_B, "user-b", "b@x.test");

    const session = await provider.login({ email: "b@x.test", password: PASSWORD });
    expect(session.user.tenantId).toBe(TENANT_B);
    await db.dispose();
  });

  it("a session resolves inside the tenant its token names, even when the same user id exists elsewhere", async () => {
    // THE ISOLATION TEST. Same user id in both tenants, deployment configured
    // for A, token issued for B. `getCurrentUser` used to look the id up in
    // the CONFIGURED tenant, so B's token would have returned A's user —
    // different account, different data, same id.
    const { db, credentials, provider } = await harness(TENANT_A);
    await seedUser(credentials, TENANT_A, "same-id", "a@x.test", "owner");
    await seedUser(credentials, TENANT_B, "same-id", "b@x.test", "member");

    const sessionB = await provider.login({ email: "b@x.test", password: PASSWORD });
    const resolved = await provider.getCurrentUser(sessionB.accessToken);

    expect(resolved).not.toBeNull();
    expect(resolved!.tenantId).toBe(TENANT_B);
    expect(resolved!.email).toBe("b@x.test");
    // If this leaked into TENANT_A the role would read "owner".
    expect(resolved!.role).toBe("member");
    await db.dispose();
  });

  it("revoking one tenant's sessions leaves the other tenant's session valid", async () => {
    const { db, credentials, provider } = await harness(TENANT_A);
    await seedUser(credentials, TENANT_A, "user-a", "a@x.test");
    await seedUser(credentials, TENANT_B, "user-b", "b@x.test");

    const sessionA = await provider.login({ email: "a@x.test", password: PASSWORD });
    const sessionB = await provider.login({ email: "b@x.test", password: PASSWORD });

    await credentials.revokeSessions({ tenantId: TENANT_A } as never, "user-a" as never);

    expect(await provider.getCurrentUser(sessionA.accessToken)).toBeNull();
    expect(await provider.getCurrentUser(sessionB.accessToken)).not.toBeNull();
    await db.dispose();
  });

  it("rejects a token signed with a different key, whatever tenant it claims", async () => {
    const { db, credentials, provider } = await harness(TENANT_A);
    await seedUser(credentials, TENANT_A, "user-a", "a@x.test");
    const session = await provider.login({ email: "a@x.test", password: PASSWORD });

    const otherKeyProvider = new JwtAuthProvider(
      { secret: "1".repeat(64), tenantId: TENANT_A, issuer: "test-issuer", audience: "test-audience" },
      credentials,
      new PermissionService(),
    );
    expect(await otherKeyProvider.getCurrentUser(session.accessToken)).toBeNull();
    await db.dispose();
  });

  it("refuses an unverified credential even with the right password", async () => {
    const { db, credentials, provider } = await harness(TENANT_A);
    await credentials.create({ tenantId: TENANT_A } as never, {
      userId: "unverified",
      email: "unverified@x.test",
      passwordHash: await hashPassword(PASSWORD, 1_000),
      role: "member",
      verifiedAt: null,
    } as never);

    await expect(provider.login({ email: "unverified@x.test", password: PASSWORD })).rejects.toThrow();
    await db.dispose();
  });

  it("rejects a wrong password, and reports the same failure for an unknown email", async () => {
    // Identical messages on purpose: a different response for "no such user"
    // turns the login form into an account-existence oracle.
    const { db, credentials, provider } = await harness(TENANT_A);
    await seedUser(credentials, TENANT_A, "user-a", "a@x.test");

    await expect(provider.login({ email: "a@x.test", password: "wrong password here" })).rejects.toThrow(
      /Invalid email or password/,
    );
    await expect(provider.login({ email: "nobody@x.test", password: PASSWORD })).rejects.toThrow(
      /Invalid email or password/,
    );
    await db.dispose();
  });
});
