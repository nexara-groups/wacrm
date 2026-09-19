/**
 * SQL implementation of `SignupRepository` — the ONE place a brand-new
 * tenant is created.
 *
 * Schema: db/migrations/d1/0001_identity.sql (`users`),
 * 0002_organizations.sql (`accounts`, `memberships`) and
 * 0011_credentials.sql (`credentials`); the global email uniqueness that
 * makes duplicate-signup detection possible is 0013_global_email_uniqueness.sql.
 *
 * -----------------------------------------------------------------------
 * ATOMICITY — one `batch()`, all four rows or none
 * -----------------------------------------------------------------------
 * D1 has no interactive transactions (`DatabaseProvider.transaction()`
 * throws — see `scripts/check-architecture.mjs` rule 2b), so the only
 * atomic multi-statement primitive available on every candidate store is
 * `batch()`. All four inserts — `accounts`, `users`, `credentials`,
 * `memberships` — go through exactly one `batch()` call. D1 batches are
 * atomic (same guarantee `SqlSeatRepository`'s header documents), and the
 * sql.js test provider wraps its own `batch()` in a real
 * `BEGIN`/`COMMIT`/`ROLLBACK` — so on EITHER store, a failure partway
 * through rolls back everything already staged in the same call. That is
 * what makes "duplicate email creates nothing" true without this
 * repository ever having to undo an earlier insert by hand.
 *
 * The one row that can plausibly collide is `credentials` (its `email`
 * column carries the global UNIQUE index); `accounts.id` and
 * `users.user_id` are freshly generated UUIDs from the caller
 * (`SignupService`) and cannot collide with an existing row. When the
 * `credentials` insert violates that index, the whole batch throws and
 * every statement in it — including the `accounts`/`users` rows inserted
 * moments earlier in the same call — is rolled back. `isDuplicateEmailError`
 * below recognizes that specific failure (by inspecting the thrown error,
 * and its `cause` chain if the provider wrapped it) and reports it as the
 * ordinary `"email_taken"` outcome instead of an exception — the same
 * pattern `SqlSeatRepository.reserveSeatAndCreateInvitation` uses for "no
 * seat left" (return a sentinel, don't throw for an expected result). Any
 * OTHER failure (a real DB error, a schema mismatch) is rethrown unchanged;
 * this repository only ever reinterprets the one failure mode it knows how
 * to name.
 *
 * `accounts` is deliberately NOT tenant-scoped by a `where` clause — it IS
 * the tenant root, its own `id` is the tenant id being created — hence the
 * `tenant-scope-exempt:` marker `scripts/check-architecture.mjs` requires
 * for that statement (mirrors `SqlSeatRepository`'s `resolvedSeatLimitSubquery`
 * comment for the same table).
 */
import type { AtomicBatchDatabaseProvider } from "@nexara/core/database";
import type {
  CreateTenantInput,
  CreateTenantResult,
  SignupRepository,
} from "../application/ports";

/**
 * Walks `error` and its `cause` chain (an `AppError` wraps the provider's
 * native exception in `.cause` — see `D1DatabaseProvider.batch`) looking for
 * the SQLite/D1 unique-constraint message naming `credentials`/`email`.
 * sql.js (the test/dev provider) throws the raw, unwrapped error instead —
 * checking the top-level message first covers that case with no chain walk
 * needed at all.
 */
export function isDuplicateEmailError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const message =
      current instanceof Error ? current.message : typeof current === "string" ? current : "";
    // Matches on the unique-constraint signal ALONE, deliberately not also on
    // the table and column names.
    //
    // This file's header already establishes that `credentials.email` is the
    // only unique constraint a signup can violate: `accounts.id`,
    // `users.user_id` and the membership id are all freshly generated UUIDs
    // from this same call. So naming the table and column adds no safety —
    // there is no other unique violation to confuse it with — while adding a
    // way to fail. Engines word these differently, and D1 in particular can
    // return a terser message for a failure inside a batch. If the column
    // name were missing, this returned false, the error was rethrown, and the
    // single most common signup error — someone already has an account —
    // became a 500 instead of "try logging in instead".
    //
    // A false positive here would be safe anyway: the batch rolled back
    // either way, so the worst case is a misleading message, not a corrupt
    // tenant.
    // UNIQUE-specific wording only. An earlier attempt at this widened the
    // match to any "constraint failed", which swallowed NOT NULL violations
    // too and would have reported a schema bug as "that email is taken" — the
    // repository's own test for rethrowing unrelated failures caught it.
    // Covers SQLite/D1 ("UNIQUE constraint failed", "SQLITE_CONSTRAINT_UNIQUE")
    // and Postgres ("duplicate key value violates unique constraint"), since
    // both adapters are live.
    if (/unique constraint|SQLITE_CONSTRAINT_UNIQUE|duplicate key value/i.test(message)) {
      return true;
    }
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export class SqlSignupRepository implements SignupRepository {
  constructor(private readonly db: AtomicBatchDatabaseProvider) {}

  async createTenant(input: CreateTenantInput): Promise<CreateTenantResult> {
    const now = input.now.toISOString();
    // Defaults to `true` — see `CreateTenantInput.autoVerifyEmail`'s own
    // doc for why the default preserves the original behavior. `false` is
    // supplied only once email can actually be sent (the caller's call,
    // never this repository's).
    const verifiedAt = input.autoVerifyEmail === false ? null : now;
    try {
      await this.db.batch([
        {
          sql: `-- tenant-scope-exempt: accounts IS the tenant root; its own id is the tenant id being created here
                insert into accounts (id, name, owner_user_id, created_at, updated_at)
                values ($1, $2, $3, $4, $4)`,
          params: [input.accountId, input.accountName, input.ownerUserId, now],
        },
        {
          sql: `insert into users (user_id, tenant_id, email, display_name, role, email_verified_at, created_at, updated_at)
                values ($1, $2, $3, $4, 'owner', $5, $6, $6)`,
          params: [input.ownerUserId, input.accountId, input.email, input.ownerName, verifiedAt, now],
        },
        {
          // Marked verified immediately UNLESS the caller says a real
          // verification email is going out (`autoVerifyEmail: false`) —
          // see `CreateTenantInput.autoVerifyEmail`'s doc. Auto-verifying
          // unconditionally used to be the only option because nothing
          // upstream could ever send that email; it still is the fallback
          // when nothing can, so a deployment with no email provider
          // configured never locks every new owner out.
          sql: `insert into credentials (user_id, tenant_id, email, password_hash, role, verified_at)
                values ($1, $2, $3, $4, 'owner', $5)`,
          params: [input.ownerUserId, input.accountId, input.email, input.passwordHash, verifiedAt],
        },
        {
          sql: `insert into memberships (id, account_id, user_id, role, created_at, deactivated_at)
                values ($1, $2, $3, 'owner', $4, null)`,
          params: [input.membershipId, input.accountId, input.ownerUserId, now],
        },
      ]);
      return { kind: "created" };
    } catch (error) {
      if (isDuplicateEmailError(error)) return { kind: "email_taken" };
      throw error;
    }
  }
}
