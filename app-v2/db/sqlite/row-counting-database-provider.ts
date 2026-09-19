/**
 * Test-only instrumentation: wraps an `AtomicBatchDatabaseProvider` (in
 * practice always `SqlJsDatabaseProvider` in tests — see that file's own
 * header for why it must never be wired in production) and counts every row
 * returned by every `query()` call made through it.
 *
 * This is what the D1-rows-read cost tests use to assert a page read is
 * bounded by page size, not by table size: Cloudflare D1's free tier meters
 * rows READ (~5M/day), not requests or bytes, so "the route only fetched 20
 * rows" has to be checked at the row-count level, not just asserted in a
 * comment. See `modules/conversations/infrastructure/conversation-repository.test.ts`
 * and `modules/broadcasts/infrastructure/broadcast-repository.test.ts`'s
 * "read cost" suites.
 *
 * Not used by any production or dev-harness code path.
 */
import type {
  AtomicBatchDatabaseProvider,
  BatchQuery,
  QueryResult,
  Row,
  Transaction,
} from "@nexara/core/database";

export class RowCountingDatabaseProvider implements AtomicBatchDatabaseProvider {
  readonly name: string;

  /** Running total of rows returned by every `query()` call made through this wrapper. */
  totalRowsReturned = 0;

  constructor(private readonly inner: AtomicBatchDatabaseProvider) {
    this.name = inner.name;
  }

  async query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
    const result = await this.inner.query<T>(sql, params);
    this.totalRowsReturned += result.rows.length;
    return result;
  }

  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.inner.transaction(work);
  }

  batch(queries: readonly BatchQuery[]): Promise<readonly QueryResult[]> {
    return this.inner.batch(queries);
  }

  dispose(): Promise<void> {
    return this.inner.dispose();
  }

  /** Zeroes the counter — call after seeding, before the read under test. */
  reset(): void {
    this.totalRowsReturned = 0;
  }
}
