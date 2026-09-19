/**
 * SQL implementation of `AccountDirectory` over `AtomicBatchDatabaseProvider`.
 *
 * Schema: db/migrations/d1/0002_organizations.sql (`accounts`).
 *
 * `listAccountIds` is the one query in this codebase whose job IS to read
 * across every tenant — not a per-tenant read that forgot to scope itself.
 * That is a real, intentional exception to "every statement filters
 * account_id" (see `scripts/check-architecture.mjs` rule 3's own comment,
 * which names this exact case), so the SQL below carries an explicit
 * `tenant-scope-exempt:` marker with the reason, matching the pattern
 * `SqlSeatRepository` and `SqlSignupRepository` already use for their own
 * `accounts` reads/writes (there the exemption is "accounts IS the tenant
 * root"; here it is "this enumerates every tenant root, on purpose").
 *
 * NOTE: no backtick appears anywhere in either SQL comment below. The guard
 * matches backtick-delimited blocks, so one would split the block and
 * orphan the marker from the SQL it is meant to exempt — silently failing
 * the check instead of passing it.
 *
 * Keyset-paginated by `accounts.id` (its primary key) ascending — never
 * `OFFSET`, which would re-scan skipped rows on every page, and never an
 * unbounded read of every row that loads the whole table into memory to
 * page it in JS. Row reads are metered same as writes on the free tier, so
 * a caller walking the whole fleet (the nightly retention sweep) pays only
 * for the page it asked for.
 */
import type { AtomicBatchDatabaseProvider, Row } from "@nexara/core/database";
import type { AccountDirectory, AccountIdPage } from "../application/ports";

export class SqlAccountDirectoryRepository implements AccountDirectory {
  constructor(private readonly db: AtomicBatchDatabaseProvider) {}

  async listAccountIds(cursor: string | null, limit: number): Promise<AccountIdPage> {
    const boundedLimit = Math.max(1, Math.floor(limit));
    // Read one MORE row than asked, same trick `sweepExpiredMessages` uses:
    // its presence is how we know a next page exists without a second
    // COUNT(*) over the same range.
    const { rows } =
      cursor === null
        ? await this.db.query<Row>(
            `-- tenant-scope-exempt: enumerates every account for a platform
             -- maintenance job (the nightly message-retention sweep), which by
             -- definition must walk every tenant; there is no single tenant_id
             -- to filter by here, on purpose, not by omission.
             select id from accounts order by id asc limit $1`,
            [boundedLimit + 1],
          )
        : await this.db.query<Row>(
            `-- tenant-scope-exempt: enumerates every account for a platform
             -- maintenance job (the nightly message-retention sweep), which by
             -- definition must walk every tenant; there is no single tenant_id
             -- to filter by here, on purpose, not by omission.
             select id from accounts where id > $1 order by id asc limit $2`,
            [cursor, boundedLimit + 1],
          );

    const hasMore = rows.length > boundedLimit;
    const page = rows.slice(0, boundedLimit).map((r) => String(r.id));
    const last = page[page.length - 1];
    return {
      accountIds: page,
      nextCursor: hasMore && last !== undefined ? last : null,
    };
  }
}
