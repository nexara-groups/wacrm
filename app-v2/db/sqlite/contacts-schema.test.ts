import { describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "./sqljs-database-provider";
import { runMigrations } from "./run-migrations";

async function freshDb() {
  const db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  await db.query(
    `insert into users (user_id, tenant_id, email, role, created_at, updated_at)
     values ('u1','acct-1','o@x.test','owner','t','t')`,
  );
  await db.query(
    `insert into accounts (id, name, owner_user_id, created_at, updated_at)
     values ('acct-1','A','u1','t','t')`,
  );
  return db;
}

describe("0007_contacts schema", () => {
  it("adds the profile columns and the tag/custom-field/import tables", async () => {
    const db = await freshDb();
    const { rows } = await db.query<{ name: string }>(
      "select name from sqlite_master where type='table'",
    );
    const tables = rows.map((r) => r.name);
    for (const t of [
      "tags", "contact_tags", "custom_field_definitions",
      "contact_custom_values", "contact_imports", "contact_import_rejections",
    ]) {
      expect(tables, `missing ${t}`).toContain(t);
    }
    await db.query(
      `insert into contacts (id, account_id, phone, display_name, email, company, created_at, updated_at)
       values ('c1','acct-1','+919876543210','Asha','a@x.test','Acme','t','t')`,
    );
    const got = await db.query<{ display_name: string; company: string }>(
      "select display_name, company from contacts where account_id = $1",
      ["acct-1"],
    );
    expect(got.rows[0]?.display_name).toBe("Asha");
    expect(got.rows[0]?.company).toBe("Acme");
    await db.dispose();
  });

  it("REFUSES a duplicate phone in the same account — the consent-preserving dedup guarantee", async () => {
    const db = await freshDb();
    await db.query(
      `insert into contacts (id, account_id, phone, consent_state, created_at, updated_at)
       values ('c1','acct-1','+919876543210','opted_out','t','t')`,
    );
    // A CSV re-import of the same number must not be able to land a second
    // row with default consent — that is how an opted-out person gets
    // silently re-subscribed (META_ERROR_TAXONOMY.md §3b).
    await expect(
      db.query(
        `insert into contacts (id, account_id, phone, consent_state, created_at, updated_at)
         values ('c2','acct-1','+919876543210','unknown','t','t')`,
      ),
    ).rejects.toThrow();

    const { rows } = await db.query<{ consent_state: string }>(
      "select consent_state from contacts where account_id = $1",
      ["acct-1"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consent_state).toBe("opted_out");
    await db.dispose();
  });

  it("allows the same phone in a DIFFERENT account — opt-out is per account", async () => {
    const db = await freshDb();
    await db.query(
      `insert into users (user_id, tenant_id, email, role, created_at, updated_at)
       values ('u2','acct-2','o2@x.test','owner','t','t')`,
    );
    await db.query(
      `insert into accounts (id, name, owner_user_id, created_at, updated_at)
       values ('acct-2','B','u2','t','t')`,
    );
    await db.query(
      `insert into contacts (id, account_id, phone, consent_state, created_at, updated_at)
       values ('c1','acct-1','+919876543210','opted_out','t','t')`,
    );
    await db.query(
      `insert into contacts (id, account_id, phone, consent_state, created_at, updated_at)
       values ('c2','acct-2','+919876543210','opted_in','t','t')`,
    );
    const { rows } = await db.query<{ n: number }>("select count(*) as n from contacts");
    expect(rows[0]?.n).toBe(2);
    await db.dispose();
  });
});
