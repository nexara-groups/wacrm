import { AppError } from "../../../shared/errors";
import type {
  AtomicBatchDatabaseProvider,
  BatchQuery,
  QueryResult,
  Row,
  Transaction,
} from "../database-provider.interface";

/** Minimal structural type for the Cloudflare D1 binding. */
export interface D1DatabaseBinding {
  prepare(query: string): D1PreparedStatement;
  batch(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Result<T = Record<string, unknown>> {
  readonly results: T[];
  readonly success: boolean;
  readonly meta?: { readonly changes?: number };
}

export interface D1DatabaseConfig {
  readonly db: D1DatabaseBinding;
}

/**
 * D1 implementation using the framework's `$1` positional-parameter convention.
 * D1 batches are atomic; interactive callback transactions are not available.
 */
export class D1DatabaseProvider implements AtomicBatchDatabaseProvider {
  readonly name = "d1";

  constructor(private readonly config: D1DatabaseConfig) {}

  async query<T extends Row = Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    try {
      return toQueryResult(await this.prepare(sql, params).all<T>());
    } catch (error) {
      throw AppError.database("D1 query failed", error);
    }
  }

  async batch(queries: readonly BatchQuery[]): Promise<readonly QueryResult[]> {
    if (queries.length === 0) return [];
    try {
      const statements = queries.map(({ sql, params = [] }) => this.prepare(sql, params));
      return (await this.config.db.batch(statements)).map(toQueryResult);
    } catch (error) {
      throw AppError.database("D1 batch failed", error);
    }
  }

  async transaction<T>(_work: (tx: Transaction) => Promise<T>): Promise<T> {
    throw AppError.database("D1 does not support interactive transactions; use batch instead");
  }

  async dispose(): Promise<void> {
    // D1 is a Workers binding and has no connection pool to close.
  }

  private prepare(sql: string, params: readonly unknown[]): D1PreparedStatement {
    return this.config.db.prepare(sql.replace(/\$(\d+)/g, "?$1")).bind(...params);
  }
}

function toQueryResult<T extends Row = Row>(result: D1Result<T>): QueryResult<T> {
  return {
    rows: result.results,
    rowCount: result.results.length > 0
      ? result.results.length
      : Number(result.meta?.changes ?? 0),
  };
}
