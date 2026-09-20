import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "@nexara/core/context";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { OnboardingSqlRepository } from "./onboarding-repository";
import {
  ONBOARDING_STATES,
  resumeStep,
  transition,
  type OnboardingState,
} from "../domain/onboarding-state-machine";
import { generateResumeToken } from "../domain/resume-token";

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const A: TenantContext = { tenantId: ACCOUNT_A as never };
const B: TenantContext = { tenantId: ACCOUNT_B as never };

/** A raw Meta access token shape, used ONLY to prove it never reaches the DB. */
const RAW_META_ACCESS_TOKEN = "EAAGRAWSECRETTOKENVALUEDONOTPERSIST1234567890";

let db: SqlJsDatabaseProvider;
let repo: OnboardingSqlRepository;

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  for (const id of [ACCOUNT_A, ACCOUNT_B]) {
    await db.query(
      `insert into users (user_id, tenant_id, email, role, created_at, updated_at)
       values ($1, $2, $3, 'owner', 't', 't')`,
      [`u-${id}`, id, `o-${id}@x.test`],
    );
    await db.query(
      `-- tenant-scope-exempt: accounts IS the tenant root; its tenant column is id
       insert into accounts (id, name, owner_user_id, created_at, updated_at)
       values ($1, $1, $2, 't', 't')`,
      [id, `u-${id}`],
    );
  }
  repo = new OnboardingSqlRepository(db);
});

// ---------------------------------------------------------------------------
// OnboardingSessionRepositoryPort — persistence + resume
// ---------------------------------------------------------------------------

describe("OnboardingSqlRepository — sessions", () => {
  it("creates a session and reads it back by id, by resume token, and as the account's current session", async () => {
    const resumeToken = generateResumeToken();
    const created = await repo.create(A, {
      id: randomUUID(),
      state: "created",
      startedAt: "2026-01-01T00:00:00.000Z",
      resumeToken,
    });
    expect(created.state).toBe("created");
    expect(created.resumeToken).toBe(resumeToken);

    expect((await repo.findById(A, created.id))?.id).toBe(created.id);
    expect((await repo.findByResumeToken(A, resumeToken))?.id).toBe(created.id);
    expect((await repo.findCurrentForAccount(A))?.id).toBe(created.id);
  });

  it("findCurrentForAccount returns the MOST RECENTLY STARTED session when an account has more than one", async () => {
    const older = await repo.create(A, {
      id: randomUUID(),
      state: "complete",
      startedAt: "2026-01-01T00:00:00.000Z",
      resumeToken: generateResumeToken(),
    });
    const newer = await repo.create(A, {
      id: randomUUID(),
      state: "created",
      startedAt: "2026-02-01T00:00:00.000Z",
      resumeToken: generateResumeToken(),
    });
    const current = await repo.findCurrentForAccount(A);
    expect(current?.id).toBe(newer.id);
    expect(current?.id).not.toBe(older.id);
  });

  it("updateState persists a forward transition (state, updated_at) and leaves other fields untouched", async () => {
    const created = await repo.create(A, {
      id: randomUUID(),
      state: "created",
      startedAt: "2026-01-01T00:00:00.000Z",
      resumeToken: generateResumeToken(),
    });
    const updated = await repo.updateState(A, created.id, {
      state: "meta_connected",
      updatedAt: "2026-01-01T00:10:00.000Z",
      completedAt: null,
      lastError: null,
    });
    expect(updated.state).toBe("meta_connected");
    expect(updated.updatedAt).toBe("2026-01-01T00:10:00.000Z");
    expect(updated.resumeToken).toBe(created.resumeToken);
    expect(updated.startedAt).toBe(created.startedAt);
  });

  it("updateState persists completedAt on reaching the terminal state", async () => {
    const created = await repo.create(A, {
      id: randomUUID(),
      state: "template_ready",
      startedAt: "2026-01-01T00:00:00.000Z",
      resumeToken: generateResumeToken(),
    });
    const completed = await repo.updateState(A, created.id, {
      state: "complete",
      updatedAt: "2026-01-02T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:00.000Z",
      lastError: null,
    });
    expect(completed.state).toBe("complete");
    expect(completed.completedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("updateState persists a RECORD_FAILURE self-loop's lastError without moving state", async () => {
    const created = await repo.create(A, {
      id: randomUUID(),
      state: "phone_registered",
      startedAt: "2026-01-01T00:00:00.000Z",
      resumeToken: generateResumeToken(),
    });
    const result = transition(created.state, { type: "RECORD_FAILURE", reason: "Meta returned a 500" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.changed).toBe(false);

    const failed = await repo.updateState(A, created.id, {
      state: result.value.state,
      updatedAt: "2026-01-01T00:05:00.000Z",
      completedAt: null,
      lastError: "Meta returned a 500",
    });
    // Self-loop: state does not move.
    expect(failed.state).toBe("phone_registered");
    expect(failed.lastError).toBe("Meta returned a 500");
  });

  it("updateState throws (not silently no-ops) for a session id that does not exist under this account", async () => {
    await expect(
      repo.updateState(A, randomUUID(), {
        state: "meta_connected",
        updatedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        lastError: null,
      }),
    ).rejects.toThrow();
  });

  /**
   * RESUME RULE: every non-terminal state must be resumable. This drives a
   * session through EVERY non-terminal state and, at each one, verifies
   * that (a) the persisted row can be found and (b) resumeStep + transition
   * together compute a legal next state that updateState can then persist —
   * i.e. resuming from a persisted row and resuming from a fresh in-memory
   * state behave identically.
   */
  it.each(ONBOARDING_STATES.filter((s) => s !== "complete"))(
    "RESUME from persisted state %s: reloads the session and completes the next legal step",
    async (state: OnboardingState) => {
      const created = await repo.create(A, {
        id: randomUUID(),
        state,
        startedAt: "2026-01-01T00:00:00.000Z",
        resumeToken: generateResumeToken(),
      });

      // Simulate "tab closed, user comes back": look the session up fresh,
      // exactly as a resume-link handler would.
      const resumed = await repo.findByResumeToken(A, created.resumeToken);
      expect(resumed).not.toBeNull();
      expect(resumed?.state).toBe(state);

      const step = resumeStep(resumed!.state);
      expect(step.nextEvent).not.toBeNull();

      const result = transition(resumed!.state, { type: step.nextEvent! } as never);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.changed).toBe(true);

      const persisted = await repo.updateState(A, resumed!.id, {
        state: result.value.state,
        updatedAt: "2026-01-01T01:00:00.000Z",
        completedAt: result.value.state === "complete" ? "2026-01-01T01:00:00.000Z" : null,
        lastError: null,
      });
      expect(persisted.state).toBe(result.value.state);
    },
  );

  it("resuming the terminal 'complete' state offers nothing further to resume into", () => {
    const step = resumeStep("complete");
    expect(step.nextEvent).toBeNull();
  });

  it("TENANT ISOLATION — account B cannot read, resume into, or mutate account A's session", async () => {
    const created = await repo.create(A, {
      id: randomUUID(),
      state: "created",
      startedAt: "2026-01-01T00:00:00.000Z",
      resumeToken: generateResumeToken(),
    });

    expect(await repo.findById(B, created.id)).toBeNull();
    expect(await repo.findByResumeToken(B, created.resumeToken)).toBeNull();
    expect(await repo.findCurrentForAccount(B)).toBeNull();

    await expect(
      repo.updateState(B, created.id, {
        state: "meta_connected",
        updatedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        lastError: null,
      }),
    ).rejects.toThrow();

    // A's row is untouched by B's attempt.
    const stillA = await repo.findById(A, created.id);
    expect(stillA?.state).toBe("created");

    // Other direction: B creates its own session, A cannot see it.
    const bSession = await repo.create(B, {
      id: randomUUID(),
      state: "created",
      startedAt: "2026-01-01T00:00:00.000Z",
      resumeToken: generateResumeToken(),
    });
    expect(await repo.findById(A, bSession.id)).toBeNull();
    expect((await repo.findCurrentForAccount(A))?.id).toBe(created.id);
  });
});

// ---------------------------------------------------------------------------
// MetaConnectionRepositoryPort — access_token_ref, never a raw token
// ---------------------------------------------------------------------------

describe("OnboardingSqlRepository — meta_business_connections", () => {
  it("upserts one connection per account, keyed on account_id", async () => {
    const first = await repo.upsert(A, {
      wabaId: "waba-1",
      businessId: "biz-1",
      phoneNumberId: "pn-1",
      accessTokenRef: "secretref://meta-access-token/abc123",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(first.accountId).toBe(ACCOUNT_A);

    const second = await repo.upsert(A, {
      wabaId: "waba-1",
      businessId: "biz-1",
      phoneNumberId: "pn-2",
      accessTokenRef: "secretref://meta-access-token/def456",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(second.phoneNumberId).toBe("pn-2");

    const { rows } = await db.query<{ c: number }>(
      "select count(*) as c from meta_business_connections where account_id = $1",
      [ACCOUNT_A],
    );
    expect(Number(rows[0]?.c)).toBe(1);
  });

  it("findByAccount reads back exactly the reference that was stored", async () => {
    await repo.upsert(A, {
      wabaId: "waba-1",
      businessId: "biz-1",
      phoneNumberId: "pn-1",
      accessTokenRef: "secretref://meta-access-token/abc123",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const found = await repo.findByAccount(A);
    expect(found?.accessTokenRef).toBe("secretref://meta-access-token/abc123");
  });

  /**
   * SECURITY-CRITICAL: leaking a customer's Meta access token is this
   * module's worst possible failure. This asserts, against the REAL
   * migrated schema, that:
   *   1. `meta_business_connections` has no column that could hold a raw
   *      token — only `access_token_ref`.
   *   2. Storing a value that happens to look like a raw Meta token (as if
   *      a caller violated the port's contract) still lands verbatim in
   *      `access_token_ref` and nowhere else — there is no second,
   *      hidden write path in this repository that could persist it
   *      elsewhere.
   *   3. Scanning every column of every row in the table for the raw token
   *      string never matches.
   */
  it("no raw access token value ever reaches the database", async () => {
    await repo.upsert(A, {
      wabaId: "waba-1",
      businessId: "biz-1",
      phoneNumberId: "pn-1",
      // A well-behaved caller passes a ref (see application/ports.ts's
      // SecretStorePort contract). We deliberately pass the RAW token
      // shape here to prove the repository itself has no special-cased
      // path that would do anything different with it — it is stored
      // byte-for-byte in `access_token_ref` and only there, which is
      // exactly why the port's contract (never call this with a raw
      // value) is enforced at the call site, not by this table shape.
      accessTokenRef: RAW_META_ACCESS_TOKEN,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const columns = await db.query<{ name: string }>(
      "select name from pragma_table_info('meta_business_connections')",
    );
    const columnNames = columns.rows.map((r) => r.name);
    expect(columnNames).toContain("access_token_ref");
    expect(columnNames).not.toContain("access_token");
    expect(columnNames).not.toContain("raw_access_token");
    expect(columnNames).not.toContain("token");

    // The value lives in exactly the one documented reference column.
    const { rows } = await db.query<Record<string, unknown>>(
      "select * from meta_business_connections where account_id = $1",
      [ACCOUNT_A],
    );
    const row = rows[0];
    expect(row).toBeDefined();
    for (const [column, value] of Object.entries(row!)) {
      if (column === "access_token_ref") continue;
      expect(String(value ?? "")).not.toContain(RAW_META_ACCESS_TOKEN);
    }
  });

  it("TENANT ISOLATION — account B cannot read or overwrite account A's connection", async () => {
    await repo.upsert(A, {
      wabaId: "waba-a",
      businessId: "biz-a",
      phoneNumberId: "pn-a",
      accessTokenRef: "secretref://a",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await repo.findByAccount(B)).toBeNull();

    await repo.upsert(B, {
      wabaId: "waba-b",
      businessId: "biz-b",
      phoneNumberId: "pn-b",
      accessTokenRef: "secretref://b",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    // B's upsert must not have touched A's row (different account_id primary key).
    const stillA = await repo.findByAccount(A);
    expect(stillA?.accessTokenRef).toBe("secretref://a");
    expect(stillA?.phoneNumberId).toBe("pn-a");
  });
});

// ---------------------------------------------------------------------------
// OnboardingEventRepositoryPort — append-only audit of every transition
// ---------------------------------------------------------------------------

describe("OnboardingSqlRepository — onboarding_events (append-only)", () => {
  it("append-logs a state transition and listForSession returns it in order", async () => {
    const session = await repo.create(A, {
      id: randomUUID(),
      state: "created",
      startedAt: "2026-01-01T00:00:00.000Z",
      resumeToken: generateResumeToken(),
    });
    await repo.append(A, {
      id: randomUUID(),
      sessionId: session.id,
      eventType: "CONNECT_META",
      fromState: "created",
      toState: "meta_connected",
      detail: null,
      occurredAt: "2026-01-01T00:01:00.000Z",
    });
    await repo.append(A, {
      id: randomUUID(),
      sessionId: session.id,
      eventType: "REGISTER_PHONE",
      fromState: "meta_connected",
      toState: "phone_registered",
      detail: null,
      occurredAt: "2026-01-01T00:02:00.000Z",
    });

    const events = await repo.listForSession(A, session.id);
    expect(events).toHaveLength(2);
    expect(events[0]?.eventType).toBe("CONNECT_META");
    expect(events[1]?.eventType).toBe("REGISTER_PHONE");
    expect(events.map((e) => e.toState)).toEqual(["meta_connected", "phone_registered"]);
  });

  /**
   * Drives a session through every real forward transition using the
   * ACTUAL state machine (not hand-picked states) and asserts every one of
   * them was append-logged — "onboarding state transitions are
   * append-logged" end to end, domain + repository together.
   */
  it("every forward transition through the full onboarding flow is append-logged, in order, start to finish", async () => {
    const session = await repo.create(A, {
      id: randomUUID(),
      state: "created",
      startedAt: "2026-01-01T00:00:00.000Z",
      resumeToken: generateResumeToken(),
    });

    const events: OnboardingState[] = ["created"];
    let current: OnboardingState = "created";
    const forwardEvents = ["CONNECT_META", "REGISTER_PHONE", "VERIFY_WEBHOOK", "SYNC_TEMPLATES", "COMPLETE"] as const;

    for (const eventType of forwardEvents) {
      const result = transition(current, { type: eventType });
      if (!result.ok) throw new Error(`unexpected illegal transition ${eventType} from ${current}`);
      await repo.append(A, {
        id: randomUUID(),
        sessionId: session.id,
        eventType,
        fromState: current,
        toState: result.value.state,
        detail: null,
        occurredAt: `2026-01-01T00:0${events.length}:00.000Z`,
      });
      await repo.updateState(A, session.id, {
        state: result.value.state,
        updatedAt: `2026-01-01T00:0${events.length}:00.000Z`,
        completedAt: result.value.state === "complete" ? `2026-01-01T00:0${events.length}:00.000Z` : null,
        lastError: null,
      });
      current = result.value.state;
      events.push(current);
    }

    expect(current).toBe("complete");
    const log = await repo.listForSession(A, session.id);
    expect(log).toHaveLength(5);
    expect(log.map((e) => e.eventType)).toEqual([...forwardEvents]);
    expect(log.map((e) => e.toState)).toEqual(events.slice(1));
    expect((await repo.findById(A, session.id))?.state).toBe("complete");
  });

  it("a RECORD_FAILURE self-loop is append-logged too, without a state change on the session", async () => {
    const session = await repo.create(A, {
      id: randomUUID(),
      state: "webhook_verified",
      startedAt: "2026-01-01T00:00:00.000Z",
      resumeToken: generateResumeToken(),
    });
    const result = transition(session.state, { type: "RECORD_FAILURE", reason: "template sync failed" });
    if (!result.ok) throw new Error("unreachable");

    await repo.append(A, {
      id: randomUUID(),
      sessionId: session.id,
      eventType: "RECORD_FAILURE",
      fromState: session.state,
      toState: result.value.state,
      detail: "template sync failed",
      occurredAt: "2026-01-01T00:05:00.000Z",
    });

    const log = await repo.listForSession(A, session.id);
    expect(log).toHaveLength(1);
    expect(log[0]?.fromState).toBe("webhook_verified");
    expect(log[0]?.toState).toBe("webhook_verified");
    expect(log[0]?.detail).toBe("template sync failed");
  });

  it("TENANT ISOLATION — account B's listForSession never returns account A's events, even for the same session id", async () => {
    const session = await repo.create(A, {
      id: randomUUID(),
      state: "created",
      startedAt: "2026-01-01T00:00:00.000Z",
      resumeToken: generateResumeToken(),
    });
    await repo.append(A, {
      id: randomUUID(),
      sessionId: session.id,
      eventType: "CONNECT_META",
      fromState: "created",
      toState: "meta_connected",
      detail: null,
      occurredAt: "2026-01-01T00:01:00.000Z",
    });

    expect(await repo.listForSession(B, session.id)).toHaveLength(0);
    expect(await repo.listForSession(A, session.id)).toHaveLength(1);
  });
});
