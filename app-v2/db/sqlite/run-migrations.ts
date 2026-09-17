/**
 * Applies the D1 migration stream to a sql.js database, in filename order.
 *
 * This is how the dev harness and the contract tests get a real schema: the
 * same SQL that ships to D1, executed unmodified. If a migration is not valid
 * SQLite, this is where it surfaces — which is the point. A migration stream
 * that has never been executed is a guess.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlJsDatabaseProvider } from "./sqljs-database-provider";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/d1", import.meta.url));

export interface AppliedMigration {
  readonly file: string;
  readonly statements: number;
}

/** Migration filenames sorted by their numeric prefix, e.g. 0001, 0002, 0010. */
export function migrationFiles(dir: string = MIGRATIONS_DIR): readonly string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export function runMigrations(
  db: SqlJsDatabaseProvider,
  dir: string = MIGRATIONS_DIR,
): readonly AppliedMigration[] {
  const applied: AppliedMigration[] = [];
  for (const file of migrationFiles(dir)) {
    const sql = readFileSync(join(dir, file), "utf8");
    try {
      db.exec(sql);
    } catch (error) {
      // Name the file. A bare SQLite error with no filename is close to
      // useless across a 15-migration stream.
      throw new Error(
        `Migration ${file} failed to apply: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    applied.push({ file, statements: countStatements(sql) });
  }
  return applied;
}

/** Rough statement count for reporting — comments and blank lines excluded. */
function countStatements(sql: string): number {
  return sql
    .split(";")
    .map((s) =>
      s
        .replace(/--[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim(),
    )
    .filter((s) => s.length > 0).length;
}
