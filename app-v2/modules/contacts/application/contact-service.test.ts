import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@shared/result";
import type { TenantContext } from "@nexara/core/context";
import { ContactId, type AccountId } from "../../../packages/domain/src/ids";
import { parsePhoneNumber, type PhoneNumber } from "../../../packages/domain/src/phone-number";
import type { ContactCustomFieldValue, CustomFieldDefinition, CustomFieldId, CustomFieldType } from "../domain/custom-fields";
import { canonicalTagKey, type Tag, type TagId } from "../domain/tags";
import { ContactService } from "./contact-service";
import type {
  ConsentPatch,
  ContactImportRun,
  ContactProfilePatch,
  ContactRecord,
  ContactRepository,
  ContactSearchFilter,
  DeliverabilityPatch,
  NewContactImportRun,
  NewContactInput,
  Page,
  PageRequest,
} from "./ports";

const NOW = new Date("2026-09-17T00:00:00Z");

function tenant(id: string): TenantContext {
  return { tenantId: id };
}

let idCounter = 0;
function nextContactId(): ReturnType<typeof ContactId> {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, "0");
  return ContactId(`00000000-0000-4000-8000-${hex}`);
}

interface AccountStore {
  contacts: Map<string, ContactRecord>;
  tags: Map<string, Tag>;
  contactTags: Map<string, Set<string>>;
  customFieldDefs: Map<string, CustomFieldDefinition>; // keyed by field key
  customFieldValues: Map<string, Map<string, ContactCustomFieldValue>>; // contactId -> fieldId -> value
  importRuns: ContactImportRun[];
}

/**
 * In-memory fake for `ContactRepository`, tenant-scoped (a separate
 * `AccountStore` per `tenant.tenantId` — mirrors `FakeSeatRepository`'s
 * pattern in modules/organizations). Never shares rows across tenants,
 * which is what the "tenant isolation" tests below rely on.
 */
class FakeContactRepository implements ContactRepository {
  private readonly stores = new Map<string, AccountStore>();
  private tagCounter = 0;
  private fieldCounter = 0;

  private store(tenant: TenantContext): AccountStore {
    let store = this.stores.get(tenant.tenantId);
    if (!store) {
      store = {
        contacts: new Map(),
        tags: new Map(),
        contactTags: new Map(),
        customFieldDefs: new Map(),
        customFieldValues: new Map(),
        importRuns: [],
      };
      this.stores.set(tenant.tenantId, store);
    }
    return store;
  }

  /** Test-only seed helper — bypasses `create` so tests can set up
   *  arbitrary consent/deliverability state directly. */
  seed(tenant: TenantContext, contact: ContactRecord): void {
    this.store(tenant).contacts.set(contact.id, contact);
  }

  async create(tenant: TenantContext, input: NewContactInput): Promise<ContactRecord> {
    const store = this.store(tenant);
    const record: ContactRecord = {
      id: nextContactId(),
      accountId: tenant.tenantId as AccountId,
      phoneNumber: input.phoneNumber,
      displayName: input.displayName,
      email: input.email,
      company: input.company,
      consentState: input.consentState ?? "unknown",
      optedOutAt: input.optedOutAt ?? null,
      optOutSource: input.optOutSource ?? null,
      optOutEvidence: input.optOutEvidence ?? null,
      optOutScope: input.optOutScope ?? "all",
      deliverabilityState: "unknown",
      suppressedAt: null,
      suppressedReasonCode: null,
      suppressionStrikes: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    store.contacts.set(record.id, record);
    return record;
  }

  async findById(tenant: TenantContext, contactId: string): Promise<ContactRecord | null> {
    return this.store(tenant).contacts.get(contactId) ?? null;
  }

  async findByPhone(tenant: TenantContext, phone: PhoneNumber): Promise<ContactRecord | null> {
    for (const c of this.store(tenant).contacts.values()) {
      if (c.phoneNumber === phone) return c;
    }
    return null;
  }

  async listAll(tenant: TenantContext): Promise<readonly ContactRecord[]> {
    return Array.from(this.store(tenant).contacts.values());
  }

  async updateProfile(
    tenant: TenantContext,
    contactId: string,
    patch: ContactProfilePatch,
  ): Promise<ContactRecord | null> {
    const store = this.store(tenant);
    const existing = store.contacts.get(contactId);
    if (!existing) return null;
    const updated: ContactRecord = {
      ...existing,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.company !== undefined ? { company: patch.company } : {}),
      updatedAt: NOW.toISOString(),
    };
    store.contacts.set(contactId, updated);
    return updated;
  }

  async applyConsentPatch(
    tenant: TenantContext,
    contactId: string,
    patch: ConsentPatch,
  ): Promise<ContactRecord | null> {
    const store = this.store(tenant);
    const existing = store.contacts.get(contactId);
    if (!existing) return null;
    const updated: ContactRecord = {
      ...existing,
      consentState: patch.state,
      optedOutAt: patch.optedOutAt,
      optOutSource: patch.source,
      optOutEvidence: patch.evidence,
      optOutScope: patch.scope,
      updatedAt: NOW.toISOString(),
    };
    store.contacts.set(contactId, updated);
    return updated;
  }

  async applyDeliverabilityPatch(
    tenant: TenantContext,
    contactId: string,
    patch: DeliverabilityPatch,
  ): Promise<ContactRecord | null> {
    const store = this.store(tenant);
    const existing = store.contacts.get(contactId);
    if (!existing) return null;
    const updated: ContactRecord = {
      ...existing,
      deliverabilityState: patch.state,
      suppressedAt: patch.suppressedAt,
      suppressedReasonCode: patch.suppressedReasonCode,
      suppressionStrikes: patch.suppressionStrikes,
      updatedAt: NOW.toISOString(),
    };
    store.contacts.set(contactId, updated);
    return updated;
  }

  async delete(tenant: TenantContext, contactId: string): Promise<void> {
    this.store(tenant).contacts.delete(contactId);
  }

  async search(tenant: TenantContext, filter: ContactSearchFilter, page: PageRequest): Promise<Page<ContactRecord>> {
    const store = this.store(tenant);
    let items = Array.from(store.contacts.values());
    if (filter.consentState) items = items.filter((c) => c.consentState === filter.consentState);
    if (filter.deliverabilityState) items = items.filter((c) => c.deliverabilityState === filter.deliverabilityState);
    if (filter.query) {
      const q = filter.query.toLowerCase();
      items = items.filter(
        (c) =>
          (c.displayName ?? "").toLowerCase().includes(q) ||
          (c.email ?? "").toLowerCase().includes(q) ||
          (c.company ?? "").toLowerCase().includes(q),
      );
    }
    if (filter.tagFilter && filter.tagFilter.tagIds.length > 0) {
      const { tagIds, mode } = filter.tagFilter;
      items = items.filter((c) => {
        const assigned = store.contactTags.get(c.id) ?? new Set<string>();
        return mode === "all"
          ? tagIds.every((id) => assigned.has(id))
          : tagIds.some((id) => assigned.has(id));
      });
    }
    const total = items.length;
    const start = (page.page - 1) * page.pageSize;
    const pageItems = items.slice(start, start + page.pageSize);
    return { items: pageItems, total };
  }

  async listTags(tenant: TenantContext): Promise<readonly Tag[]> {
    return Array.from(this.store(tenant).tags.values());
  }

  async findOrCreateTagsByName(tenant: TenantContext, names: readonly string[]): Promise<readonly Tag[]> {
    const store = this.store(tenant);
    const result: Tag[] = [];
    for (const name of names) {
      const key = canonicalTagKey(name);
      let tag = Array.from(store.tags.values()).find((t) => canonicalTagKey(t.name) === key);
      if (!tag) {
        this.tagCounter += 1;
        tag = {
          id: `tag-${this.tagCounter}` as TagId,
          accountId: tenant.tenantId as AccountId,
          name,
          color: null,
          createdAt: NOW.toISOString(),
        };
        store.tags.set(tag.id, tag);
      }
      result.push(tag);
    }
    return result;
  }

  async assignTags(tenant: TenantContext, contactId: string, tagIds: readonly TagId[]): Promise<void> {
    const store = this.store(tenant);
    const existing = store.contactTags.get(contactId) ?? new Set<string>();
    for (const id of tagIds) existing.add(id);
    store.contactTags.set(contactId, existing);
  }

  async listTagIdsForContact(tenant: TenantContext, contactId: string): Promise<readonly TagId[]> {
    return Array.from(this.store(tenant).contactTags.get(contactId) ?? []) as TagId[];
  }

  async listCustomFieldDefinitions(tenant: TenantContext): Promise<readonly CustomFieldDefinition[]> {
    return Array.from(this.store(tenant).customFieldDefs.values());
  }

  async findOrCreateCustomFieldDefinition(
    tenant: TenantContext,
    key: string,
    label: string,
    type: CustomFieldType,
  ): Promise<CustomFieldDefinition> {
    const store = this.store(tenant);
    const existing = store.customFieldDefs.get(key);
    if (existing) return existing;
    this.fieldCounter += 1;
    const definition: CustomFieldDefinition = {
      id: `field-${this.fieldCounter}` as CustomFieldId,
      accountId: tenant.tenantId as AccountId,
      key,
      label,
      type,
      options: null,
      createdAt: NOW.toISOString(),
    };
    store.customFieldDefs.set(key, definition);
    return definition;
  }

  async getCustomFieldValues(tenant: TenantContext, contactId: string): Promise<readonly ContactCustomFieldValue[]> {
    return Array.from(this.store(tenant).customFieldValues.get(contactId)?.values() ?? []);
  }

  async setCustomFieldValues(
    tenant: TenantContext,
    contactId: string,
    values: readonly ContactCustomFieldValue[],
  ): Promise<void> {
    const store = this.store(tenant);
    const byField = store.customFieldValues.get(contactId) ?? new Map<string, ContactCustomFieldValue>();
    for (const v of values) byField.set(v.fieldId, v);
    store.customFieldValues.set(contactId, byField);
  }

  async recordImportRun(tenant: TenantContext, run: NewContactImportRun): Promise<ContactImportRun> {
    const store = this.store(tenant);
    const record: ContactImportRun = { ...run, id: `run-${store.importRuns.length + 1}`, accountId: tenant.tenantId };
    store.importRuns.push(record);
    return record;
  }
}

function makeService() {
  const repository = new FakeContactRepository();
  const service = new ContactService({ repository, clock: () => NOW });
  return { repository, service };
}

describe("ContactService — dedup", () => {
  it("two spellings of one number resolve to a single contact", async () => {
    const { service } = makeService();
    const t = tenant("acct-1");
    const created = await service.createContact(t, { phone: "9876543210" });
    expect(isOk(created)).toBe(true);

    const second = await service.createContact(t, { phone: "+91 98765 43210" });
    expect(isErr(second)).toBe(true);
    if (isErr(second)) {
      expect(second.error.code).toBe("CONFLICT");
    }
  });
});

describe("ContactService — CSV import: THE consent-preservation guarantee", () => {
  it("re-importing an opted-out contact never resubscribes them", async () => {
    const { repository, service } = makeService();
    const t = tenant("acct-1");
    const phone = parsePhoneNumber("+919876543210");

    repository.seed(t, {
      id: nextContactId(),
      accountId: "acct-1" as AccountId,
      phoneNumber: phone,
      displayName: "Asha",
      email: null,
      company: null,
      consentState: "opted_out",
      optedOutAt: "2026-01-01T00:00:00.000Z",
      optOutSource: "keyword",
      optOutEvidence: "wamid.original-stop-message",
      optOutScope: "all",
      deliverabilityState: "reachable",
      suppressedAt: null,
      suppressedReasonCode: null,
      suppressionStrikes: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const csv = "phone,name\n9876543210,Asha Updated Name";
    const result = await service.importContactsFromCsv(t, csv);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.createdCount).toBe(0);
    expect(result.value.updatedCount).toBe(1);

    const after = await service.searchContacts(t, {}, { page: 1, pageSize: 10 });
    const contact = after.items[0]!;
    expect(contact.displayName).toBe("Asha Updated Name"); // profile field updated
    // Consent completely untouched — the regression this module guards against.
    expect(contact.consentState).toBe("opted_out");
    expect(contact.optedOutAt).toBe("2026-01-01T00:00:00.000Z");
    expect(contact.optOutSource).toBe("keyword");
    expect(contact.optOutEvidence).toBe("wamid.original-stop-message");
  });

  it("re-import preserves suppression (deliverability) state too", async () => {
    const { repository, service } = makeService();
    const t = tenant("acct-1");
    const phone = parsePhoneNumber("+919876543211");

    repository.seed(t, {
      id: nextContactId(),
      accountId: "acct-1" as AccountId,
      phoneNumber: phone,
      displayName: "Bob",
      email: null,
      company: null,
      consentState: "unknown",
      optedOutAt: null,
      optOutSource: null,
      optOutEvidence: null,
      optOutScope: "all",
      deliverabilityState: "suppressed",
      suppressedAt: "2026-02-01T00:00:00.000Z",
      suppressedReasonCode: "131026",
      suppressionStrikes: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const csv = "phone,name\n9876543211,Bob Updated";
    const result = await service.importContactsFromCsv(t, csv);
    expect(isOk(result)).toBe(true);

    const after = await service.searchContacts(t, {}, { page: 1, pageSize: 10 });
    const contact = after.items[0]!;
    expect(contact.displayName).toBe("Bob Updated");
    expect(contact.deliverabilityState).toBe("suppressed");
    expect(contact.suppressedReasonCode).toBe("131026");
    expect(contact.suppressionStrikes).toBe(1);
  });

  it("reports malformed rows and invalid phone numbers with layman reasons, without aborting the whole import", async () => {
    const { service } = makeService();
    const t = tenant("acct-1");
    const csv = [
      "phone,name,email",
      "+919876543210,Asha,asha@example.com", // valid
      "+919876543211,Missing Column", // malformed: too few columns
      "not-a-number,Broken,broken@example.com", // invalid phone
    ].join("\n");

    const result = await service.importContactsFromCsv(t, csv);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.createdCount).toBe(1);
    expect(result.value.rejectedRows).toHaveLength(2);
    for (const rejection of result.value.rejectedRows) {
      expect(rejection.reason).not.toMatch(/E\.164|NSN|AppError|VALIDATION/i);
    }
  });
});

describe("ContactService — tag filtering", () => {
  it("filters contacts by assigned tags", async () => {
    const { service } = makeService();
    const t = tenant("acct-1");
    const vip = await service.createContact(t, { phone: "+919876500001", displayName: "VIP Contact" });
    const plain = await service.createContact(t, { phone: "+919876500002", displayName: "Plain Contact" });
    if (!isOk(vip) || !isOk(plain)) throw new Error("setup failed");

    await service.assignTagsToContact(t, vip.value.id, ["VIP"]);

    const tags = await service.listTags(t);
    const vipTag = tags.find((tag) => tag.name === "VIP")!;

    const filtered = await service.searchContacts(
      t,
      { tagFilter: { tagIds: [vipTag.id], mode: "any" } },
      { page: 1, pageSize: 10 },
    );
    expect(filtered.items.map((c) => c.id)).toEqual([vip.value.id]);
    expect(filtered.items.map((c) => c.id)).not.toContain(plain.value.id);
  });
});

describe("ContactService — custom field typing", () => {
  it("stores custom field values through CSV import with the resolved definition", async () => {
    const { repository, service } = makeService();
    const t = tenant("acct-1");
    const csv = "phone,name,Loyalty Tier\n+919876500003,Carol,Gold";
    const result = await service.importContactsFromCsv(t, csv);
    expect(isOk(result)).toBe(true);

    const definitions = await repository.listCustomFieldDefinitions(t);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.key).toBe("loyalty_tier");
    expect(definitions[0]!.type).toBe("text");

    const contacts = await repository.listAll(t);
    const values = await repository.getCustomFieldValues(t, contacts[0]!.id);
    expect(values).toHaveLength(1);
    expect(values[0]!.value).toEqual({ type: "text", value: "Gold" });
  });
});

describe("ContactService — tenant isolation", () => {
  it("account A cannot read or match account B's contacts", async () => {
    const { service } = makeService();
    const acctA = tenant("acct-A");
    const acctB = tenant("acct-B");

    const createdBResult = await service.createContact(acctB, { phone: "+919876500009", displayName: "B's contact" });
    if (!isOk(createdBResult)) throw new Error("setup failed");
    const contactB = createdBResult.value;

    // A cannot find B's contact by id.
    const foundFromA = await service.getContact(acctA, contactB.id);
    expect(foundFromA).toBeNull();

    // Creating the SAME phone number under account A succeeds (no cross-tenant dedup).
    const createdA = await service.createContact(acctA, { phone: "+919876500009", displayName: "A's contact" });
    expect(isOk(createdA)).toBe(true);

    // Each account's search only sees its own contact.
    const resultsA = await service.searchContacts(acctA, {}, { page: 1, pageSize: 10 });
    const resultsB = await service.searchContacts(acctB, {}, { page: 1, pageSize: 10 });
    expect(resultsA.items).toHaveLength(1);
    expect(resultsB.items).toHaveLength(1);
    expect(resultsA.items[0]!.displayName).toBe("A's contact");
    expect(resultsB.items[0]!.displayName).toBe("B's contact");

    // B's contact opts out.
    const optOutResult = await service.recordOptOut(acctB, contactB.id, "keyword", "wamid.stop-1");
    expect(isOk(optOutResult)).toBe(true);

    // A re-import on account A cannot match/update account B's opted-out contact —
    // it only ever sees/matches contacts scoped to account A.
    const csvOnA = "phone,name\n+919876500009,Attempted Overwrite";
    const importOnA = await service.importContactsFromCsv(acctA, csvOnA);
    expect(isOk(importOnA)).toBe(true);
    if (isOk(importOnA)) {
      expect(importOnA.value.updatedCount).toBe(1); // updates A's own contact only
    }

    const bContactAfter = await service.getContact(acctB, contactB.id);
    expect(bContactAfter?.consentState).toBe("opted_out"); // untouched by account A's import
    expect(bContactAfter?.displayName).toBe("B's contact"); // untouched by account A's import
  });
});

describe("ContactService — consent transitions", () => {
  it("opt-out is not clearable by any operator method — only reOptIn, and it requires evidence", async () => {
    const { service } = makeService();
    const t = tenant("acct-1");
    const created = await service.createContact(t, { phone: "+919876500010" });
    if (!isOk(created)) throw new Error("setup failed");

    const optOut = await service.recordOptOut(t, created.value.id, "keyword", "wamid.stop-1");
    expect(isOk(optOut)).toBe(true);
    if (isOk(optOut)) expect(optOut.value.consentState).toBe("opted_out");

    // There is no operator-facing "clear opt-out" method on ContactService at
    // all — clearDoNotContact only ever operates on do_not_contact, never
    // opted_out (asserted structurally: calling it on an opted_out contact
    // is a no-op transition, guarded by canTransitionConsentState).
    const attemptedClear = await service.clearDoNotContact(t, created.value.id, "operator note");
    expect(isErr(attemptedClear)).toBe(true);

    const reOptIn = await service.reOptIn(t, created.value.id, "wamid.fresh-inbound-2");
    expect(isOk(reOptIn)).toBe(true);
    if (isOk(reOptIn)) expect(reOptIn.value.consentState).toBe("opted_in");
  });
});
