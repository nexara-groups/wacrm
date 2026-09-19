/**
 * A `DatabaseProvider` backed by sql.js (SQLite compiled to WebAssembly,
 * running in-process with no server).
 *
 * This exists so the stack can actually be RUN and exercised end to end —
 * locally, in tests, and in the dev harness — without provisioning anything.
 * It speaks the same SQLite dialect the D1 migrations target, so
 * `db/migrations/d1/*.sql` applies here unchanged.
 *
 * It is NOT a production adapter and must never be wired in the container's
 * production path: sql.js holds the whole database in memory and has no
 * durability story. Production is D1 or Postgres, decided by the still-open
 * gate in DATABASE_DECISION.md.
 *
 * Parameter convention: the `Queryable` contract specifies Postgres-style
 * positional placeholders ($1, $2, ...). SQLite uses `?`, so `query` rewrites
 * them and reorders the parameter list to match — the same adaptation the D1
 * adapter performs, kept identical on purpose so repository SQL is portable.
 */
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type {
  AtomicBatchDatabaseProvider,
  BatchQuery,
  QueryResult,
  Row,
  Transaction,
} from "@nexara/core/database";

let sqlJs: SqlJsStatic | null = null;

async function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJs ??= await initSqlJs();
  return sqlJs;
}

/**
 * Rewrites `$1`-style placeholders to `?` and returns the parameters in the
 * order SQLite will consume them.
 *
 * A statement may reference the same `$n` more than once; each occurrence
 * needs its own `?` and its own copy of the value, so this maps occurrences
 * rather than deduplicating them.
 */
export function toSqlitePlaceholders(
  sql: string,
  params: readonly unknown[],
): { sql: string; params: unknown[] } {
  const ordered: unknown[] = [];
  const rewritten = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    const position = Number(index) - 1;
    if (position < 0 || position >= params.length) {
      throw new Error(`SQL references $${index} but only ${params.length} parameter(s) were given`);
    }
    ordered.push(params[position]);
    return "?";
  });
  return { sql: rewritten, params: ordered };
}

/** sql.js accepts only these as bound values; everything else must be encoded. */
function toBindable(value: unknown): string | number | Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

class SqlJsQueryable implements Transaction {
  constructor(protected readonly db: Database) {}

  async query<T extends Row = Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const prepared = toSqlitePlaceholders(sql, params);
    const statement = this.db.prepare(prepared.sql);
    try {
      statement.bind(prepared.params.map(toBindable));
      const rows: T[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject() as T);
      }
      // getRowsModified reflects the most recent write; for a SELECT it is
      // the row count we just collected.
      const rowCount = rows.length > 0 ? rows.length : this.db.getRowsModified();
      return { rows, rowCount };
    } finally {
      statement.free();
    }
  }
}

export class SqlJsDatabaseProvider extends SqlJsQueryable implements AtomicBatchDatabaseProvider {
  readonly name = "sqljs";

  static async create(): Promise<SqlJsDatabaseProvider> {
    const SQL = await loadSqlJs();
    const db = new SQL.Database();
    // SQLite ships with foreign-key enforcement OFF. D1 has it ON. Left at
    // the default, this harness silently permits writes that production
    // rejects — verified: deleting a message that a surviving message's
    // `reply_to` points at succeeds here and fails on D1 with "FOREIGN KEY
    // constraint failed". Every test would have passed.
    //
    // Matching D1 is the whole point of running the real migration stream
    // against sql.js, so the pragma belongs here rather than in the tests
    // that happen to care.
    db.run("PRAGMA foreign_keys = ON;");
    return new SqlJsDatabaseProvider(db);
  }

  /**
   * Real SQLite transactions. `work` receives a handle over the same
   * connection — sql.js is single-connection, so the handle and the provider
   * share it; the BEGIN/COMMIT pair is what makes the unit atomic.
   */
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    this.db.run("BEGIN");
    try {
      const result = await work(new SqlJsQueryable(this.db));
      this.db.run("COMMIT");
      return result;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  async batch(queries: readonly BatchQuery[]): Promise<readonly QueryResult[]> {
    return this.transaction(async (tx) => {
      const results: QueryResult[] = [];
      for (const q of queries) {
        results.push(await tx.query(q.sql, q.params ?? []));
      }
      return results;
    });
  }

  /** Raw multi-statement execution — used by the migration runner only. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  async dispose(): Promise<void> {
    this.db.close();
  }
}
