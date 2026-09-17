/**
 * Database Layer — abstraction over the data store.
 *
 * Responsibilities: query, transaction, connection management.
 *
 * Business logic depends ONLY on this interface. It must never import the
 * Supabase (or Neon / D1) SDK directly. Migrating providers is a matter of
 * swapping the implementation registered in the DI container.
 */

/** A single row is a string-keyed record. */
export type Row = Record<string, unknown>;

/** Result of a query that may return rows and/or an affected-row count. */
export interface QueryResult<T extends Row = Row> {
  readonly rows: readonly T[];
  readonly rowCount: number;
}

/** One parameterized statement in a provider-native atomic batch. */
export interface BatchQuery {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

/**
 * Anything that can run queries: both the top-level provider and a transaction
 * handle implement this, so repository code can be written once and run inside
 * or outside a transaction.
 */
export interface Queryable {
  /**
   * Run a parameterized SQL query. Parameters use positional placeholders
   * ($1, $2, ...) — the Postgres convention shared by Supabase, Neon, and
   * (with adaptation) D1.
   */
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

/** A transaction handle — Queryable plus commit/rollback (managed for you by `transaction`). */
export interface Transaction extends Queryable {}

export interface DatabaseProvider extends Queryable {
  /** Provider identifier, e.g. "supabase" | "neon" | "d1". */
  readonly name: string;

  /**
   * Run `work` inside a transaction. Commits on success, rolls back if `work`
   * throws or returns a rejected promise. The provided handle must be used for
   * all queries inside the callback.
   */
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;

  /** Release pooled connections / close clients. Called on shutdown. */
  dispose(): Promise<void>;
}

/**
 * A database provider that can execute a fixed list of statements atomically.
 * This stays narrower than DatabaseProvider because not every HTTP-backed
 * database adapter can offer an honest multi-statement transaction.
 */
export interface AtomicBatchDatabaseProvider extends DatabaseProvider {
  batch(queries: readonly BatchQuery[]): Promise<readonly QueryResult[]>;
}
