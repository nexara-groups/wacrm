import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import { SqlContactRepository } from "./contact-repository";
import type { TenantContext } from "@nexara/core/context";
import type { ContactId } from "../../../packages/domain/src/ids";
import type { PhoneNumber } from "../../../packages/domain/src/phone-number";

const A: TenantContext = { tenantId: "acct-a" as never };
const B: TenantContext = { tenantId: "acct-b" as never };
const phone = (p: string) => p as unknown as PhoneNumber;

let db: SqlJsDatabaseProvider;
let repo: SqlContactRepository;

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  for (const id of ["acct-a", "acct-b"]) {
    await db.query(
      `insert into users (user_id, tenant_id, email, role, created_at, updated_at)
       values ($1, $2, $3, 'owner', 't', 't')`,
      [`u-${id}`, id, `o@${id}.test`],
    );
    await db.query(
      `-- tenant-scope-exempt: accounts IS the tenant root; its tenant column is id
       insert into accounts (id, name, owner_user_id, created_at, updated_at)
       values ($1, $1, $2, 't', 't')`,
      [id, `u-${id}`],
    );
  }
  repo = new SqlContactRepository(db);
});

describe("SqlContactRepository", () => {
  it("creates and reads back a contact", async () => {
    const created = await repo.create(A, {
      phoneNumber: phone("+919876543210"),
      displayName: "Asha",
      email: "asha@x.test",
      company: "Acme",
    });
    expect(created.displayName).toBe("Asha");
    expect(created.company).toBe("Acme");
    expect(created.consentState).toBe("unknown");
    expect(await repo.findByPhone(A, phone("+919876543210"))).not.toBeNull();
  });

  it("TENANT ISOLATION — account B cannot see or mutate account A's contact", async () => {
    const a = await repo.create(A, {
      phoneNumber: phone("+919876543210"), displayName: "Asha", email: null, company: null,
    });
    expect(await repo.findById(B, a.id as ContactId)).toBeNull();
    expect(await repo.findByPhone(B, phone("+919876543210"))).toBeNull();
    expect(await repo.listAll(B)).toHaveLength(0);

    // A cross-tenant update must be a no-op, not a silent success.
    expect(await repo.updateProfile(B, a.id as ContactId, { displayName: "hijacked" })).toBeNull();
    expect((await repo.findById(A, a.id as ContactId))?.displayName).toBe("Asha");

    await repo.delete(B, a.id as ContactId);
    expect(await repo.findById(A, a.id as ContactId)).not.toBeNull();
  });

  it("writes consent columns as one unit, evidence included", async () => {
    const c = await repo.create(A, {
      phoneNumber: phone("+919800000001"), displayName: null, email: null, company: null,
    });
    const updated = await repo.applyConsentPatch(A, c.id as ContactId, {
      state: "opted_out",
      optedOutAt: "2026-09-17T00:00:00.000Z",
      source: "keyword",
      evidence: "wamid.STOP.123",
      scope: "all",
    });
    expect(updated?.consentState).toBe("opted_out");
    expect(updated?.optOutEvidence).toBe("wamid.STOP.123");
    expect(updated?.optOutSource).toBe("keyword");
  });

  it("applies a deliverability patch independently of consent", async () => {
    const c = await repo.create(A, {
      phoneNumber: phone("+919800000002"), displayName: null, email: null, company: null,
    });
    const updated = await repo.applyDeliverabilityPatch(A, c.id as ContactId, {
      state: "suppressed", suppressedAt: "2026-09-17T00:00:00.000Z",
      suppressedReasonCode: "131026", suppressionStrikes: 1,
    });
    expect(updated?.deliverabilityState).toBe("suppressed");
    expect(updated?.suppressedReasonCode).toBe("131026");
    // The two axes are independent — consent is untouched.
    expect(updated?.consentState).toBe("unknown");
  });

  it("get-or-creates tags case-insensitively", async () => {
    const first = await repo.findOrCreateTagsByName(A, ["VIP", "lead"]);
    const second = await repo.findOrCreateTagsByName(A, [" vip ", "Lead"]);
    expect(first.map((t) => t.id).sort()).toEqual(second.map((t) => t.id).sort());
    expect(await repo.listTags(A)).toHaveLength(2);
  });

  it("filters by tag in any and all modes", async () => {
    const [vip, lead] = await repo.findOrCreateTagsByName(A, ["VIP", "lead"]);
    const both = await repo.create(A, { phoneNumber: phone("+911"), displayName: "Both", email: null, company: null });
    const onlyVip = await repo.create(A, { phoneNumber: phone("+912"), displayName: "OnlyVip", email: null, company: null });
    await repo.assignTags(A, both.id as ContactId, [vip!.id, lead!.id]);
    await repo.assignTags(A, onlyVip.id as ContactId, [vip!.id]);

    const anyVip = await repo.search(A, { tagFilter: { tagIds: [vip!.id], mode: "any" } }, { page: 1, pageSize: 10 });
    expect(anyVip.total).toBe(2);

    const allBoth = await repo.search(A, { tagFilter: { tagIds: [vip!.id, lead!.id], mode: "all" } }, { page: 1, pageSize: 10 });
    expect(allBoth.total).toBe(1);
    expect(allBoth.items[0]?.displayName).toBe("Both");
  });

  it("searches free-text and paginates", async () => {
    for (let i = 0; i < 5; i++) {
      await repo.create(A, {
        phoneNumber: phone(`+9198000100${i}`), displayName: `Person ${i}`,
        email: `p${i}@acme.test`, company: "Acme",
      });
    }
    const hit = await repo.search(A, { query: "acme" }, { page: 1, pageSize: 3 });
    expect(hit.total).toBe(5);
    expect(hit.items).toHaveLength(3);
    const page2 = await repo.search(A, { query: "acme" }, { page: 2, pageSize: 3 });
    expect(page2.items).toHaveLength(2);
  });

  it("round-trips typed custom field values", async () => {
    const c = await repo.create(A, { phoneNumber: phone("+913"), displayName: null, email: null, company: null });
    const num = await repo.findOrCreateCustomFieldDefinition(A, "score", "Score", "number");
    const flag = await repo.findOrCreateCustomFieldDefinition(A, "vip", "VIP", "boolean");
    await repo.setCustomFieldValues(A, c.id as ContactId, [
      { contactId: c.id as ContactId, fieldId: num.id, value: { type: "number", value: 42 } },
      { contactId: c.id as ContactId, fieldId: flag.id, value: { type: "boolean", value: true } },
    ]);
    const values = await repo.getCustomFieldValues(A, c.id as ContactId);
    const byField = new Map(values.map((v) => [v.fieldId, v.value]));
    expect(byField.get(num.id)).toEqual({ type: "number", value: 42 });
    expect(byField.get(flag.id)).toEqual({ type: "boolean", value: true });
  });

  it("persists import rejections with their reasons", async () => {
    const run = await repo.recordImportRun(A, {
      startedAt: "t0", finishedAt: "t1", totalRows: 3,
      createdCount: 1, updatedCount: 1, actorUserId: null,
      rejectedRows: [{ rowNumber: 3, reason: "This phone number isn't valid. Check the country code." }],
    });
    const { rows } = await db.query<{ reason: string; row_number: number }>(
      "select reason, row_number from contact_import_rejections where account_id = $1 and import_id = $2",
      ["acct-a", run.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row_number).toBe(3);
    expect(rows[0]?.reason).toContain("country code");
  });
});
