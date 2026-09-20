import { describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "./sqljs-database-provider";
import { migrationFiles, runMigrations } from "./run-migrations";

describe("the D1 migration stream applies to a real SQLite engine", () => {
  it("applies every migration in order", async () => {
    const db = await SqlJsDatabaseProvider.create();
    const applied = runMigrations(db);
    expect(applied.length).toBe(migrationFiles().length);
    await db.dispose();
  });

  it("creates the tables the modules depend on", async () => {
    const db = await SqlJsDatabaseProvider.create();
    runMigrations(db);
    const { rows } = await db.query<{ name: string }>(
      "select name from sqlite_master where type = 'table' order by name",
    );
    const tables = rows.map((r) => r.name);
    for (const expected of [
      "accounts", "users", "contacts", "conversations", "messages",
      "broadcasts", "broadcast_recipients", "platform_settings",
      "platform_admins", "meta_error_codes",
    ]) {
      expect(tables, `missing table ${expected}`).toContain(expected);
    }
    await db.dispose();
  });

  it("seeds the platform default seat limit at 3", async () => {
    const db = await SqlJsDatabaseProvider.create();
    runMigrations(db);
    const { rows } = await db.query<{ default_seat_limit: number }>(
      "select default_seat_limit from platform_settings",
    );
    expect(rows[0]?.default_seat_limit).toBe(3);
    await db.dispose();
  });
});
