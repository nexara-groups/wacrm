import { beforeEach, describe, expect, it } from "vitest";
import { SqlJsDatabaseProvider } from "../../../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../../../db/sqlite/run-migrations";
import {
  ContactStateRepository,
  MessageTemplateRepository,
  WebhookEventRepository,
  WhatsAppConfigRepository,
} from "./whatsapp-repository";
import { AccountId, ContactId, TemplateId } from "../../../packages/domain/src/ids";
import type { PhoneNumber } from "../../../packages/domain/src/phone-number";
import type { MetaTemplateDefinitionComponent } from "../domain/whatsapp-provider.interface";

const ACCOUNT_A = AccountId("11111111-1111-4111-8111-111111111111");
const ACCOUNT_B = AccountId("22222222-2222-4222-8222-222222222222");
const phone = (p: string) => p as unknown as PhoneNumber;

const BODY_COMPONENTS: readonly MetaTemplateDefinitionComponent[] = [
  { type: "BODY", text: "Hi {{1}}, your order {{2}} shipped." },
];

let db: SqlJsDatabaseProvider;

beforeEach(async () => {
  db = await SqlJsDatabaseProvider.create();
  runMigrations(db);
  for (const id of [ACCOUNT_A, ACCOUNT_B]) {
    await db.query(
      `insert into users (user_id, tenant_id, email, role, created_at, updated_at)
       values ($1, $2, $3, 'owner', 't', 't')`,
      [`u-${id}`, id, `o-${id}@x.test`],
    );
    await db.query(
      `-- tenant-scope-exempt: accounts IS the tenant root; its tenant column is id
       insert into accounts (id, name, owner_user_id, created_at, updated_at)
       values ($1, $1, $2, 't', 't')`,
      [id, `u-${id}`],
    );
  }
});

// ---------------------------------------------------------------------------
// WhatsAppConfigRepository
// ---------------------------------------------------------------------------

describe("WhatsAppConfigRepository", () => {
  it("upsert creates a config, then updates the same row on a second call", async () => {
    const repo = new WhatsAppConfigRepository(db);
    const created = await repo.upsert({
      accountId: ACCOUNT_A,
      phoneNumberId: "pn-1",
      wabaId: "waba-1",
      displayName: "Acme Support",
      qualityRating: "GREEN",
      verifiedName: "Acme Inc",
      registrationState: "unregistered",
      accessToken: "tok-v1",
    });
    expect(created.registrationState).toBe("unregistered");

    const updated = await repo.upsert({
      accountId: ACCOUNT_A,
      phoneNumberId: "pn-1",
      wabaId: "waba-1",
      displayName: "Acme Support 2",
      qualityRating: "YELLOW",
      verifiedName: "Acme Inc",
      registrationState: "pending",
      accessToken: "tok-v2",
    });
    // Same row (same id), not a duplicate insert.
    expect(updated.id).toBe(created.id);
    expect(updated.registrationState).toBe("pending");
    expect(updated.accessToken).toBe("tok-v2");

    const list = await repo.listByAccount(ACCOUNT_A);
    expect(list).toHaveLength(1);
  });

  it("updateRegistrationState moves the lifecycle field and updated_at", async () => {
    const repo = new WhatsAppConfigRepository(db);
    await repo.upsert({
      accountId: ACCOUNT_A,
      phoneNumberId: "pn-2",
      wabaId: "waba-2",
      displayName: null,
      qualityRating: null,
      verifiedName: null,
      registrationState: "unregistered",
      accessToken: "tok",
    });
    await repo.updateRegistrationState(ACCOUNT_A, "pn-2", "registered", "2026-01-02T00:00:00.000Z");
    const found = await repo.findByPhoneNumberId(ACCOUNT_A, "pn-2");
    expect(found?.registrationState).toBe("registered");
    expect(found?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("findByPhoneNumberId returns null for an unknown phone number id", async () => {
    const repo = new WhatsAppConfigRepository(db);
    expect(await repo.findByPhoneNumberId(ACCOUNT_A, "nope")).toBeNull();
  });

  it("TENANT ISOLATION — account B cannot read, list or mutate account A's config", async () => {
    const repo = new WhatsAppConfigRepository(db);
    await repo.upsert({
      accountId: ACCOUNT_A,
      phoneNumberId: "pn-shared-key",
      wabaId: "waba-a",
      displayName: "A's config",
      qualityRating: null,
      verifiedName: null,
      registrationState: "registered",
      accessToken: "secret-a",
    });

    expect(await repo.findByPhoneNumberId(ACCOUNT_B, "pn-shared-key")).toBeNull();
    expect(await repo.listByAccount(ACCOUNT_B)).toHaveLength(0);

    // B's updateRegistrationState against A's phone_number_id must not affect A's row.
    await repo.updateRegistrationState(ACCOUNT_B, "pn-shared-key", "failed", "2026-01-01T00:00:00.000Z");
    const stillA = await repo.findByPhoneNumberId(ACCOUNT_A, "pn-shared-key");
    expect(stillA?.registrationState).toBe("registered");

    // The other direction: A cannot see anything created under B.
    await repo.upsert({
      accountId: ACCOUNT_B,
      phoneNumberId: "pn-b-only",
      wabaId: "waba-b",
      displayName: "B's config",
      qualityRating: null,
      verifiedName: null,
      registrationState: "unregistered",
      accessToken: "secret-b",
    });
    expect(await repo.findByPhoneNumberId(ACCOUNT_A, "pn-b-only")).toBeNull();
    expect(await repo.listByAccount(ACCOUNT_A)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MessageTemplateRepository
// ---------------------------------------------------------------------------

describe("MessageTemplateRepository", () => {
  it("upserts a template and reads it back by meta id and by internal id", async () => {
    const repo = new MessageTemplateRepository(db);
    const created = await repo.upsert({
      accountId: ACCOUNT_A,
      metaTemplateId: "meta-tpl-1",
      name: "order_shipped",
      language: "en_US",
      category: "utility",
      status: "pending",
      bodyText: "Hi {{1}}, your order {{2}} shipped.",
      variableCount: 2,
      components: BODY_COMPONENTS,
    });
    expect(created.status).toBe("pending");

    const byMeta = await repo.findByMetaTemplateId(ACCOUNT_A, "meta-tpl-1");
    expect(byMeta?.id).toBe(created.id);
    expect(byMeta?.components).toEqual(BODY_COMPONENTS);

    const byId = await repo.findById(ACCOUNT_A, created.id as TemplateId);
    expect(byId?.name).toBe("order_shipped");
  });

  it("upsert on an existing (account_id, meta_template_id) updates rather than duplicates", async () => {
    const repo = new MessageTemplateRepository(db);
    const first = await repo.upsert({
      accountId: ACCOUNT_A,
      metaTemplateId: "meta-tpl-2",
      name: "welcome",
      language: "en_US",
      category: "marketing",
      status: "pending",
      bodyText: "Welcome!",
      variableCount: 0,
      components: [],
    });
    const second = await repo.upsert({
      accountId: ACCOUNT_A,
      metaTemplateId: "meta-tpl-2",
      name: "welcome_v2",
      language: "en_US",
      category: "marketing",
      status: "pending",
      bodyText: "Welcome aboard!",
      variableCount: 0,
      components: [],
    });
    expect(second.id).toBe(first.id);
    const all = await repo.listByAccount(ACCOUNT_A);
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe("welcome_v2");
  });

  /**
   * The load-bearing lifecycle write: Meta reviews a template asynchronously
   * and calls back with an approval-status change. This must reach the
   * stored row without touching anything else about it.
   */
  it("updateStatus moves the approval status independently of other columns", async () => {
    const repo = new MessageTemplateRepository(db);
    await repo.upsert({
      accountId: ACCOUNT_A,
      metaTemplateId: "meta-tpl-3",
      name: "otp",
      language: "en_US",
      category: "authentication",
      status: "pending",
      bodyText: "Your code is {{1}}",
      variableCount: 1,
      components: [],
    });
    await repo.updateStatus(ACCOUNT_A, "meta-tpl-3", "approved", "2026-01-05T00:00:00.000Z");
    const approved = await repo.findByMetaTemplateId(ACCOUNT_A, "meta-tpl-3");
    expect(approved?.status).toBe("approved");
    expect(approved?.name).toBe("otp");
    expect(approved?.updatedAt).toBe("2026-01-05T00:00:00.000Z");

    await repo.updateStatus(ACCOUNT_A, "meta-tpl-3", "rejected", "2026-01-06T00:00:00.000Z");
    const rejected = await repo.findByMetaTemplateId(ACCOUNT_A, "meta-tpl-3");
    expect(rejected?.status).toBe("rejected");
  });

  it("delete removes the template row", async () => {
    const repo = new MessageTemplateRepository(db);
    await repo.upsert({
      accountId: ACCOUNT_A,
      metaTemplateId: "meta-tpl-4",
      name: "temp",
      language: "en_US",
      category: "utility",
      status: "pending",
      bodyText: "",
      variableCount: 0,
      components: [],
    });
    await repo.delete(ACCOUNT_A, "meta-tpl-4");
    expect(await repo.findByMetaTemplateId(ACCOUNT_A, "meta-tpl-4")).toBeNull();
  });

  it("TENANT ISOLATION — account B cannot read, update, delete or list account A's templates", async () => {
    const repo = new MessageTemplateRepository(db);
    const created = await repo.upsert({
      accountId: ACCOUNT_A,
      metaTemplateId: "meta-tpl-shared",
      name: "a_only",
      language: "en_US",
      category: "utility",
      status: "pending",
      bodyText: "",
      variableCount: 0,
      components: [],
    });

    expect(await repo.findByMetaTemplateId(ACCOUNT_B, "meta-tpl-shared")).toBeNull();
    expect(await repo.findById(ACCOUNT_B, created.id as TemplateId)).toBeNull();
    expect(await repo.listByAccount(ACCOUNT_B)).toHaveLength(0);

    // Cross-tenant status update / delete must be no-ops against A's row.
    await repo.updateStatus(ACCOUNT_B, "meta-tpl-shared", "approved", "2026-01-01T00:00:00.000Z");
    expect((await repo.findByMetaTemplateId(ACCOUNT_A, "meta-tpl-shared"))?.status).toBe("pending");

    await repo.delete(ACCOUNT_B, "meta-tpl-shared");
    expect(await repo.findByMetaTemplateId(ACCOUNT_A, "meta-tpl-shared")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WebhookEventRepository — idempotency is the load-bearing behaviour here.
// ---------------------------------------------------------------------------

describe("WebhookEventRepository", () => {
  it("claiming a fresh event id succeeds and reports isNew: true", async () => {
    const repo = new WebhookEventRepository(db);
    const result = await repo.claim(ACCOUNT_A, "wamid.EVENT_1", { field: "messages" }, "2026-01-01T00:00:00.000Z");
    expect(result.isNew).toBe(true);
  });

  /**
   * THE core guarantee: Meta redelivers webhooks routinely. A duplicate
   * delivery of the same event id must be stored once and processed once.
   * This proves the repository relies on the DB's UNIQUE constraint (a
   * single INSERT ... ON CONFLICT DO NOTHING) rather than a read-then-write
   * race — inserting the same event id twice must be safe and must leave
   * EXACTLY ONE row.
   */
  it("a duplicate event id is idempotent: exactly one row survives, second claim reports isNew: false", async () => {
    const repo = new WebhookEventRepository(db);
    const first = await repo.claim(ACCOUNT_A, "wamid.DUPLICATE", { n: 1 }, "2026-01-01T00:00:00.000Z");
    const second = await repo.claim(ACCOUNT_A, "wamid.DUPLICATE", { n: 1 }, "2026-01-01T00:05:00.000Z");

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);

    const { rows } = await db.query<{ c: number }>(
      "select count(*) as c from whatsapp_webhook_events where event_id = $1",
      ["wamid.DUPLICATE"],
    );
    expect(Number(rows[0]?.c)).toBe(1);
  });

  it("redelivering the same event id many times concurrently still leaves exactly one row", async () => {
    const repo = new WebhookEventRepository(db);
    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        repo.claim(ACCOUNT_A, "wamid.RACE", { attempt: i }, `2026-01-01T00:0${i}:00.000Z`),
      ),
    );
    const wins = attempts.filter((a) => a.isNew);
    expect(wins).toHaveLength(1);

    const { rows } = await db.query<{ c: number }>(
      "select count(*) as c from whatsapp_webhook_events where event_id = $1",
      ["wamid.RACE"],
    );
    expect(Number(rows[0]?.c)).toBe(1);
  });

  it("event ids are a GLOBAL uniqueness key: two different accounts claiming the same event id still collide", async () => {
    // Per the repository's own docstring: Meta's message ids are globally
    // unique, so a redelivery of the exact same event must collide
    // regardless of which account processes it first — this is what makes
    // "one failure suppresses a contact twice" impossible even across a
    // misrouted redelivery.
    const repo = new WebhookEventRepository(db);
    const first = await repo.claim(ACCOUNT_A, "wamid.CROSS_ACCOUNT", {}, "2026-01-01T00:00:00.000Z");
    const second = await repo.claim(ACCOUNT_B, "wamid.CROSS_ACCOUNT", {}, "2026-01-01T00:00:00.000Z");
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);

    const { rows } = await db.query<{ c: number }>(
      "select count(*) as c from whatsapp_webhook_events where event_id = $1",
      ["wamid.CROSS_ACCOUNT"],
    );
    expect(Number(rows[0]?.c)).toBe(1);
  });

  it("distinct event ids for the same account are each stored once", async () => {
    const repo = new WebhookEventRepository(db);
    await repo.claim(ACCOUNT_A, "wamid.A", {}, "2026-01-01T00:00:00.000Z");
    await repo.claim(ACCOUNT_A, "wamid.B", {}, "2026-01-01T00:00:00.000Z");
    const { rows } = await db.query<{ c: number }>(
      "select count(*) as c from whatsapp_webhook_events where account_id = $1",
      [ACCOUNT_A],
    );
    expect(Number(rows[0]?.c)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ContactStateRepository — reads/writes migration 0005's contacts /
// contact_delivery_events tables.
// ---------------------------------------------------------------------------

describe("ContactStateRepository", () => {
  async function seedContact(accountId: string, id: string, phoneValue: string): Promise<void> {
    await db.query(
      `insert into contacts (id, account_id, phone, created_at, updated_at) values ($1, $2, $3, 't', 't')`,
      [id, accountId, phoneValue],
    );
  }

  it("findByPhoneNumber returns the deliverability/consent snapshot", async () => {
    const contactId = "33333333-3333-4333-8333-333333333333";
    await seedContact(ACCOUNT_A, contactId, "+919800000001");
    const repo = new ContactStateRepository(db);
    const snapshot = await repo.findByPhoneNumber(ACCOUNT_A, phone("+919800000001"));
    expect(snapshot?.contactId).toBe(contactId);
    expect(snapshot?.consentState).toBe("unknown");
    expect(snapshot?.deliverabilityState).toBe("unknown");
  });

  it("findByPhoneNumber returns null for an unknown number (never blocks a send)", async () => {
    const repo = new ContactStateRepository(db);
    expect(await repo.findByPhoneNumber(ACCOUNT_A, phone("+919800000099"))).toBeNull();
  });

  it("recordDeliveryEvent appends a row without mutating the contact", async () => {
    const contactId = "44444444-4444-4444-8444-444444444444";
    await seedContact(ACCOUNT_A, contactId, "+919800000002");
    const repo = new ContactStateRepository(db);
    await repo.recordDeliveryEvent({
      accountId: ACCOUNT_A,
      contactId: ContactId(contactId),
      occurredAt: "2026-01-01T00:00:00.000Z",
      errorCode: "130429",
      disposition: "THROTTLED",
      rawError: { code: 130429 },
      messageRef: "wamid.abc",
    });
    const { rows } = await db.query<{ c: number }>(
      "select count(*) as c from contact_delivery_events where account_id = $1 and contact_id = $2",
      [ACCOUNT_A, contactId],
    );
    expect(Number(rows[0]?.c)).toBe(1);
  });

  it("applyPermanentNumberFailure suppresses the contact via the shared pure state machine", async () => {
    const contactId = "55555555-5555-4555-8555-555555555555";
    await seedContact(ACCOUNT_A, contactId, "+919800000003");
    const repo = new ContactStateRepository(db);
    await repo.applyPermanentNumberFailure(ACCOUNT_A, ContactId(contactId), "131026", "2026-01-01T00:00:00.000Z");
    const snapshot = await repo.findByPhoneNumber(ACCOUNT_A, phone("+919800000003"));
    expect(snapshot?.deliverabilityState).toBe("suppressed");
    expect(snapshot?.suppressedReasonCode).toBe("131026");
  });

  it("a manually_cleared contact re-suppresses immediately on the next permanent failure (no second grace)", async () => {
    const contactId = "66666666-6666-4666-8666-666666666666";
    await seedContact(ACCOUNT_A, contactId, "+919800000004");
    await db.query(
      `update contacts set deliverability_state = 'manually_cleared', suppression_strikes = 0 where account_id = $1 and id = $2`,
      [ACCOUNT_A, contactId],
    );
    const repo = new ContactStateRepository(db);
    await repo.applyPermanentNumberFailure(ACCOUNT_A, ContactId(contactId), "131026", "2026-01-02T00:00:00.000Z");
    const { rows } = await db.query<{ deliverability_state: string; suppression_strikes: number }>(
      "select deliverability_state, suppression_strikes from contacts where account_id = $1 and id = $2",
      [ACCOUNT_A, contactId],
    );
    expect(rows[0]?.deliverability_state).toBe("suppressed");
    expect(rows[0]?.suppression_strikes).toBe(1);
  });

  it("TENANT ISOLATION — account B cannot read account A's contact state or forge delivery events onto it", async () => {
    const contactId = "77777777-7777-4777-8777-777777777777";
    await seedContact(ACCOUNT_A, contactId, "+919800000005");
    const repo = new ContactStateRepository(db);

    expect(await repo.findByPhoneNumber(ACCOUNT_B, phone("+919800000005"))).toBeNull();

    // A cross-tenant permanent-failure write must not affect A's row.
    await repo.applyPermanentNumberFailure(ACCOUNT_B, ContactId(contactId), "131026", "2026-01-01T00:00:00.000Z");
    const stillA = await repo.findByPhoneNumber(ACCOUNT_A, phone("+919800000005"));
    expect(stillA?.deliverabilityState).toBe("unknown");

    // B recording a delivery event tagged with A's contact id still writes
    // account_id = B, so it can never surface under A's tenant-scoped reads.
    await repo.recordDeliveryEvent({
      accountId: ACCOUNT_B,
      contactId: ContactId(contactId),
      occurredAt: "2026-01-01T00:00:00.000Z",
      errorCode: null,
      disposition: null,
      rawError: null,
      messageRef: null,
    });
    const { rows } = await db.query<{ c: number }>(
      "select count(*) as c from contact_delivery_events where account_id = $1 and contact_id = $2",
      [ACCOUNT_A, contactId],
    );
    expect(Number(rows[0]?.c)).toBe(0);
  });
});
