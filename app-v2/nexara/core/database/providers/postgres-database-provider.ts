/**
 * Postgres / Neon database provider.
 *
 * ── Why this file does not open a connection itself ──────────────────────
 * This adapter runs inside a Cloudflare Worker (see `container.ts`). Workers
 * cannot open a plain TCP socket to a Postgres server the way a Node server
 * can — there is no `net.Socket` available at the edge, and the driver that
 * would normally provide one (`pg`, `postgres`, ...) depends on Node's `net`/
 * `tls` modules. Two real options exist for the DATABASE_DECISION gate:
 *
 *   1. **Cloudflare Hyperdrive** — provisions a pooled, edge-local endpoint
 *      for a regular Postgres connection string and (with the `nodejs_compat`
 *      compatibility flag) lets `pg` connect to it over Workers' `connect()`
 *      Sockets API. This is the standard path for Neon/RDS/self-hosted
 *      Postgres from a Worker and is what `DATABASE_URL` should resolve to
 *      in production (`HYPERDRIVE.connectionString`, per Cloudflare's docs).
 *   2. **An HTTP/WebSocket driver** (e.g. `@neondatabase/serverless` against
 *      a Neon database) — no TCP socket needed at all, works in any Workers
 *      environment without `nodejs_compat`.
 *
 * Neither `pg` nor `@neondatabase/serverless` is an installed dependency of
 * this package today, and the DB gate in `DATABASE_DECISION.md` is still
 * PENDING — adding a driver now, before the benchmark picks a target, would
 * be exactly the "heavy dependency without need" this track was told to
 * avoid. So this adapter is written against a small `PostgresQueryExecutor`
 * seam instead of a concrete driver: it implements the full
 * `AtomicBatchDatabaseProvider` contract (query / transaction / batch /
 * dispose) correctly, but delegates the actual wire protocol to an injected
 * executor. Until one is wired, every operation fails loudly with an
 * `AppError` naming exactly what is missing, rather than silently pretending
 * to be connected.
 *
 * ── Wiring a real driver later ────────────────────────────────────────────
 * Once the gate lands on Postgres, implement `PostgresQueryExecutor` (below)
 * against the chosen driver and pass it as `executor` in the config, e.g.:
 *
 *   import { Pool } from "pg"; // after adding the dependency + Hyperdrive binding
 *   const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString });
 *   new PostgresDatabaseProvider({
 *     connectionString: env.HYPERDRIVE.connectionString,
 *     executor: {
 *       query: (sql, params) => pool.query(sql, params as unknown[]).then(toQueryResult),
 *       withConnection: async (work) => {
 *         const client = await pool.connect();
 *         try { return await work(toSession(client)); } finally { client.release(); }
 *       },
 *       dispose: () => pool.end(),
 *     },
 *   });
 *
 * `container.ts` only ever passes `{ connectionString }` (no `executor`) —
 * wiring a real driver there, behind `nodejs_compat` + a Hyperdrive binding,
 * is the composition root's job once the gate closes, not this file's.
 */
import { AppError } from "../../../shared/errors";
import type {
  AtomicBatchDatabaseProvider,
  BatchQuery,
  QueryResult,
  Queryable,
  Row,
  Transaction,
} from "../database-provider.interface";

/**
 * A session bound to one physical connection — required for `BEGIN` /
 * `COMMIT` / `ROLLBACK` to apply to the same server-side transaction. Plain
 * `PostgresQueryExecutor.query` may run on any pooled connection and must
 * never be used inside a transaction.
 */
export interface PostgresSession extends Queryable {}

/**
 * The minimal surface a real Postgres driver must provide. Deliberately
 * narrower than `pg.Pool` / `postgres.Sql` so any Workers-compatible driver
 * (Hyperdrive + `pg`, or an HTTP driver such as `@neondatabase/serverless`)
 * can be adapted to it in a few lines.
 */
export interface PostgresQueryExecutor {
  /** Run one statement on any available connection (no transaction affinity). */
  query<T extends Row = Row>(sql: string, params: readonly unknown[]): Promise<QueryResult<T>>;
  /**
   * Run `work` against a single dedicated connection so `BEGIN`/`COMMIT`/
   * `ROLLBACK` are honoured. A driver with no session affinity (a bare HTTP
   * one-statement-per-call API) cannot honestly implement this — it should
   * either offer pooled sessions or the caller should not claim transaction
   * support.
   */
  withConnection<T>(work: (session: PostgresSession) => Promise<T>): Promise<T>;
  /** Release pooled connections / close clients. Optional — default no-op. */
  dispose?(): Promise<void>;
}

export interface PostgresDatabaseConfig {
  /** Postgres connection string. In production this should be a Cloudflare
   *  Hyperdrive binding's `connectionString`, never a raw origin DSN reached
   *  by TCP directly from a Worker. Always required, even when `executor`
   *  is also supplied, so the provider can report *which* target it failed
   *  to reach. */
  readonly connectionString: string;
  /** Real driver adapter. Omit to get an honest "not wired" failure on every
   *  call instead of a fake success — see the header comment. */
  readonly executor?: PostgresQueryExecutor;
}

/**
 * Postgres implementation of `AtomicBatchDatabaseProvider`, using the same
 * `$1`, `$2`, ... positional convention the `Queryable` contract already
 * documents (it is Postgres' native placeholder syntax, so no rewriting is
 * needed here — contrast with `D1DatabaseProvider`, which rewrites for
 * SQLite's `?N` form).
 */
export class PostgresDatabaseProvider implements AtomicBatchDatabaseProvider {
  readonly name = "postgres";

  constructor(private readonly config: PostgresDatabaseConfig) {}

  async query<T extends Row = Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const executor = this.requireExecutor();
    try {
      return await executor.query<T>(sql, params);
    } catch (error) {
      throw AppError.database("Postgres query failed", error);
    }
  }

  /**
   * A real interactive transaction: `BEGIN` / `COMMIT` / `ROLLBACK` on one
   * dedicated connection, unlike D1 which has no such primitive.
   */
  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const executor = this.requireExecutor();
    try {
      return await executor.withConnection(async (session) => {
        await session.query("BEGIN");
        try {
          const result = await work(session);
          await session.query("COMMIT");
          return result;
        } catch (error) {
          await session.query("ROLLBACK").catch(() => {
            // Rollback failure is secondary to the original error below.
          });
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw AppError.database("Postgres transaction failed", error);
    }
  }

  /**
   * `AtomicBatchDatabaseProvider.batch` for Postgres: run every statement
   * inside one real transaction on a single connection. This is stronger
   * than D1's batch (which is atomic but not interactive) — implementing it
   * this way keeps behaviour a strict superset, which is what lets
   * `AUTH_PROVIDER=jwt` (the only current caller of `batch`) work unchanged
   * on either adapter.
   */
  async batch(queries: readonly BatchQuery[]): Promise<readonly QueryResult[]> {
    if (queries.length === 0) return [];
    return this.transaction(async (tx) => {
      const results: QueryResult[] = [];
      for (const { sql, params = [] } of queries) {
        results.push(await tx.query(sql, params));
      }
      return results;
    });
  }

  async dispose(): Promise<void> {
    await this.config.executor?.dispose?.();
  }

  private requireExecutor(): PostgresQueryExecutor {
    if (!this.config.executor) {
      throw AppError.provider(
        "PostgresDatabaseProvider has no query executor wired for " +
          `"${this.config.connectionString}". The DATABASE_DECISION.md gate is ` +
          "still PENDING and no Postgres driver is installed yet — see the " +
          "header comment in postgres-database-provider.ts for how to wire " +
          "one (Hyperdrive + `pg`, or an HTTP driver such as " +
          "@neondatabase/serverless) once the gate closes.",
      );
    }
    return this.config.executor;
  }
}
