import { describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../db/sqlite/run-migrations";
import { buildModuleRepositories } from "./container";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("module composition root", () => {
  it("builds module repositories over the framework's chosen database", async () => {
    const db = await SqlJsDatabaseProvider.create();
    runMigrations(db);
    const repos = buildModuleRepositories(db);
    // Reaches the real schema through the real adapter.
    expect(await repos.contacts.listAll({ tenantId: "acct-x" as never })).toEqual([]);
    await db.dispose();
  });

  it("the FRAMEWORK container must not depend on business modules", () => {
    // The layering rule this file exists to protect. If nexara/ ever imports
    // modules/, the framework stops being reusable by another Nexara vertical
    // without dragging WACRM's schema along.
    const container = readFileSync(
      fileURLToPath(new URL("../nexara/core/container.ts", import.meta.url)),
      "utf8",
    );
    expect(container).not.toMatch(/from\s+["'][^"']*modules\//);
    expect(container).not.toMatch(/@modules\//);
  });
});
