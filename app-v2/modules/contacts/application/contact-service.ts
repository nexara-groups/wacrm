/**
 * ContactService — CRUD, search, import orchestration, and the
 * consent/deliverability query & transition surface for the contacts
 * module.
 *
 * No SQL here — every persistence operation goes through the
 * `ContactRepository` port (application/ports.ts). Consent and
 * deliverability transitions are never computed ad hoc: they delegate to
 * the already-tested state machines in
 * `modules/messaging-errors/domain/consent.ts` and `.../suppression.ts`,
 * gated by the transition-legality guards in
 * `packages/domain/src/status/{consent-state,deliverability-state}.ts`.
 * This service's job is to wire those together and persist the result —
 * never to reimplement the rules.
 */
import { err, ok, type Result } from "@shared/result";
import { AppError } from "@shared/errors";
import { paginationRange } from "@shared/pagination";
import type { TenantContext } from "@nexara/core/context";
import type { UserId } from "@shared/types";
import type { ContactId } from "../../../packages/domain/src/ids";
import type { CountryCode } from "../../../packages/domain/src/phone-number";
import {
  canTransitionConsentState,
  type ConsentActor,
  type ConsentState,
} from "../../../packages/domain/src/status/consent-state";
import type { OptOutSource } from "../../../packages/domain/src/entities/contact";
import {
  clearDoNotContact as domainClearDoNotContact,
  markDoNotContact as domainMarkDoNotContact,
  optOut as domainOptOut,
  reOptIn as domainReOptIn,
  type ConsentRecord,
} from "../../messaging-errors/domain/consent";
import {
  clearSuppression as domainClearSuppression,
  recordPermanentNumberFailure as domainRecordPermanentNumberFailure,
  recordSuccess as domainRecordSuccess,
  type DeliverabilityRecord,
} from "../../messaging-errors/domain/suppression";
import { resolveDedupKey } from "../domain/contact-dedup";
import { parseCsvTable, planContactImport } from "../domain/csv-import";
import { slugifyFieldKey, validateCustomFieldValue, type ContactCustomFieldValue } from "../domain/custom-fields";
import { dedupeTagNames } from "../domain/tags";
import type {
  ConsentPatch,
  ContactImportRun,
  ContactProfilePatch,
  ContactRecord,
  ContactRepository,
  ContactSearchFilter,
  DeliverabilityPatch,
  NewContactInput,
  Page,
  PageRequest,
  RejectedImportRowRecord,
} from "./ports";

export interface ContactServiceDeps {
  readonly repository: ContactRepository;
  /** Injectable clock for deterministic tests; defaults to `() => new Date()`. */
  readonly clock?: () => Date;
}

export interface PagedResult<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export interface CreateContactInput {
  readonly phone: string;
  readonly displayName?: string | null;
  readonly email?: string | null;
  readonly company?: string | null;
  readonly defaultCountry?: CountryCode;
}

export interface CsvImportOptions {
  readonly defaultCountry?: CountryCode;
  readonly actorUserId?: UserId | null;
}

export class ContactService {
  private readonly repository: ContactRepository;
  private readonly clock: () => Date;

  constructor(deps: ContactServiceDeps) {
    this.repository = deps.repository;
    this.clock = deps.clock ?? (() => new Date());
  }

  // -------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------

  async createContact(tenant: TenantContext, input: CreateContactInput): Promise<Result<ContactRecord>> {
    const phoneResult = resolveDedupKey(input.phone, input.defaultCountry ?? "IN");
    if (!phoneResult.ok) return phoneResult;

    const existing = await this.repository.findByPhone(tenant, phoneResult.value);
    if (existing) {
      return err(
        new AppError("CONFLICT", "A contact with this phone number already exists for this account."),
      );
    }

    const created = await this.repository.create(tenant, {
      phoneNumber: phoneResult.value,
      displayName: input.displayName ?? null,
      email: input.email ?? null,
      company: input.company ?? null,
    });
    return ok(created);
  }

  async getContact(tenant: TenantContext, contactId: ContactId): Promise<ContactRecord | null> {
    return this.repository.findById(tenant, contactId);
  }

  async updateContactProfile(
    tenant: TenantContext,
    contactId: ContactId,
    patch: ContactProfilePatch,
  ): Promise<ContactRecord | null> {
    return this.repository.updateProfile(tenant, contactId, patch);
  }

  async deleteContact(tenant: TenantContext, contactId: ContactId): Promise<void> {
    await this.repository.delete(tenant, contactId);
  }

  async searchContacts(
    tenant: TenantContext,
    filter: ContactSearchFilter,
    page: PageRequest,
  ): Promise<PagedResult<ContactRecord>> {
    const result = await this.repository.search(tenant, filter, page);
    return toPagedResult(result, page);
  }

  // -------------------------------------------------------------------
  // Suppression / consent queries (META_ERROR_TAXONOMY.md §4b "Suppressed
  // contacts list" / audience-exclusion reporting)
  // -------------------------------------------------------------------

  async listSuppressedContacts(tenant: TenantContext, page: PageRequest): Promise<PagedResult<ContactRecord>> {
    const result = await this.repository.search(tenant, { deliverabilityState: "suppressed" }, page);
    return toPagedResult(result, page);
  }

  async listOptedOutContacts(tenant: TenantContext, page: PageRequest): Promise<PagedResult<ContactRecord>> {
    const result = await this.repository.search(tenant, { consentState: "opted_out" }, page);
    return toPagedResult(result, page);
  }

  async listDoNotContactContacts(tenant: TenantContext, page: PageRequest): Promise<PagedResult<ContactRecord>> {
    const result = await this.repository.search(tenant, { consentState: "do_not_contact" }, page);
    return toPagedResult(result, page);
  }

  // -------------------------------------------------------------------
  // Consent transitions — every one of these validates the transition via
  // `canTransitionConsentState` before calling the already-tested domain
  // function, and there is deliberately NO method here that lets an
  // operator clear a customer-initiated opt-out (§3b: "Opt-out is NOT
  // clearable by any operator role" — the only path is `reOptIn`, which
  // requires evidence of a fresh inbound message from the contact).
  // -------------------------------------------------------------------

  async recordOptOut(
    tenant: TenantContext,
    contactId: ContactId,
    source: Extract<OptOutSource, "keyword" | "quick_reply" | "inferred_block">,
    evidence: string,
    at: Date = this.clock(),
  ): Promise<Result<ContactRecord>> {
    const actor: ConsentActor = source === "inferred_block" ? "inferred" : "contact";
    return this.applyConsentTransition(tenant, contactId, "opted_out", actor, () =>
      domainOptOut(source, evidence, at),
    );
  }

  async markDoNotContact(
    tenant: TenantContext,
    contactId: ContactId,
    evidence: string | undefined,
    at: Date = this.clock(),
  ): Promise<Result<ContactRecord>> {
    return this.applyConsentTransition(tenant, contactId, "do_not_contact", "operator", () =>
      domainMarkDoNotContact("operator", evidence, at),
    );
  }

  /** The ONLY path back to `opted_in` from `opted_out` — `evidence` must be
   *  a durable reference to a genuine new inbound message from the contact. */
  async reOptIn(
    tenant: TenantContext,
    contactId: ContactId,
    evidence: string,
    at: Date = this.clock(),
  ): Promise<Result<ContactRecord>> {
    const contact = await this.repository.findById(tenant, contactId);
    if (!contact) return err(AppError.notFound("Contact not found"));
    if (!canTransitionConsentState(contact.consentState, "opted_in", "contact")) {
      return err(AppError.validation(`Cannot re-opt-in a contact whose consent state is "${contact.consentState}".`));
    }
    const current = toConsentRecord(contact);
    const recordResult = domainReOptIn(current, evidence, at);
    if (!recordResult.ok) return recordResult;
    return this.persistConsent(tenant, contactId, recordResult.value);
  }

  /** Clears a business-set Do-Not-Contact flag. An operator action — unlike
   *  opt-out, this is the business's own flag, not the customer's wish. */
  async clearDoNotContact(
    tenant: TenantContext,
    contactId: ContactId,
    evidence: string | undefined,
    at: Date = this.clock(),
  ): Promise<Result<ContactRecord>> {
    const contact = await this.repository.findById(tenant, contactId);
    if (!contact) return err(AppError.notFound("Contact not found"));
    if (!canTransitionConsentState(contact.consentState, "opted_in", "operator")) {
      return err(
        AppError.validation(`Cannot clear do-not-contact from consent state "${contact.consentState}".`),
      );
    }
    const current = toConsentRecord(contact);
    const recordResult = domainClearDoNotContact(current, evidence, at);
    if (!recordResult.ok) return recordResult;
    return this.persistConsent(tenant, contactId, recordResult.value);
  }

  private async applyConsentTransition(
    tenant: TenantContext,
    contactId: ContactId,
    to: ConsentState,
    actor: ConsentActor,
    build: () => ConsentRecord,
  ): Promise<Result<ContactRecord>> {
    const contact = await this.repository.findById(tenant, contactId);
    if (!contact) return err(AppError.notFound("Contact not found"));
    if (!canTransitionConsentState(contact.consentState, to, actor)) {
      // Not an error — e.g. opting out someone who is already opted out is
      // a harmless no-op, never a downgrade back toward opted_in.
      return ok(contact);
    }
    return this.persistConsent(tenant, contactId, build());
  }

  private async persistConsent(
    tenant: TenantContext,
    contactId: ContactId,
    record: ConsentRecord,
  ): Promise<Result<ContactRecord>> {
    const patch: ConsentPatch = {
      state: record.state,
      optedOutAt: record.optedOutAt ? record.optedOutAt.toISOString() : null,
      source: record.source ?? null,
      evidence: record.evidence ?? null,
      scope: record.scope,
    };
    const updated = await this.repository.applyConsentPatch(tenant, contactId, patch);
    if (!updated) return err(AppError.notFound("Contact not found"));
    return ok(updated);
  }

  // -------------------------------------------------------------------
  // Deliverability transitions — delegate entirely to
  // modules/messaging-errors/domain/suppression.ts.
  // -------------------------------------------------------------------

  async recordDeliverySuccess(tenant: TenantContext, contactId: ContactId): Promise<Result<ContactRecord>> {
    const contact = await this.repository.findById(tenant, contactId);
    if (!contact) return err(AppError.notFound("Contact not found"));
    const next = domainRecordSuccess(toDeliverabilityRecord(contact));
    return this.persistDeliverability(tenant, contactId, next);
  }

  async recordPermanentNumberFailure(
    tenant: TenantContext,
    contactId: ContactId,
    reasonCode: string,
    at: Date = this.clock(),
  ): Promise<Result<ContactRecord>> {
    const contact = await this.repository.findById(tenant, contactId);
    if (!contact) return err(AppError.notFound("Contact not found"));
    const next = domainRecordPermanentNumberFailure(toDeliverabilityRecord(contact), reasonCode, at);
    return this.persistDeliverability(tenant, contactId, next);
  }

  /** Operator override: suppressed -> manually_cleared. Reversible, unlike consent. */
  async clearContactSuppression(tenant: TenantContext, contactId: ContactId): Promise<Result<ContactRecord>> {
    const contact = await this.repository.findById(tenant, contactId);
    if (!contact) return err(AppError.notFound("Contact not found"));
    const result = domainClearSuppression(toDeliverabilityRecord(contact));
    if (!result.ok) return result;
    return this.persistDeliverability(tenant, contactId, result.value);
  }

  private async persistDeliverability(
    tenant: TenantContext,
    contactId: ContactId,
    record: DeliverabilityRecord,
  ): Promise<Result<ContactRecord>> {
    const patch: DeliverabilityPatch = {
      state: record.state,
      suppressedAt: record.suppressedAt ? record.suppressedAt.toISOString() : null,
      suppressedReasonCode: record.suppressedReasonCode ?? null,
      suppressionStrikes: record.suppressionStrikes,
    };
    const updated = await this.repository.applyDeliverabilityPatch(tenant, contactId, patch);
    if (!updated) return err(AppError.notFound("Contact not found"));
    return ok(updated);
  }

  // -------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------

  async listTags(tenant: TenantContext) {
    return this.repository.listTags(tenant);
  }

  async assignTagsToContact(tenant: TenantContext, contactId: ContactId, tagNames: readonly string[]): Promise<void> {
    const uniqueNames = dedupeTagNames(tagNames);
    if (uniqueNames.length === 0) return;
    const tags = await this.repository.findOrCreateTagsByName(tenant, uniqueNames);
    await this.repository.assignTags(tenant, contactId, tags.map((t) => t.id));
  }

  // -------------------------------------------------------------------
  // Custom fields
  // -------------------------------------------------------------------

  async listCustomFieldDefinitions(tenant: TenantContext) {
    return this.repository.listCustomFieldDefinitions(tenant);
  }

  async setContactCustomFieldValues(
    tenant: TenantContext,
    contactId: ContactId,
    rawValues: ReadonlyMap<string, { readonly label: string; readonly raw: string }>,
  ): Promise<Result<void>> {
    if (rawValues.size === 0) return ok(undefined);
    const values: ContactCustomFieldValue[] = [];
    for (const [key, { label, raw }] of rawValues) {
      const definition = await this.repository.findOrCreateCustomFieldDefinition(
        tenant,
        slugifyFieldKey(key),
        label,
        "text",
      );
      const validated = validateCustomFieldValue(definition, raw);
      if (!validated.ok) return validated;
      values.push({ contactId, fieldId: definition.id, value: validated.value });
    }
    await this.repository.setCustomFieldValues(tenant, contactId, values);
    return ok(undefined);
  }

  // -------------------------------------------------------------------
  // CSV import orchestration — the highest-risk operation in this module.
  // -------------------------------------------------------------------

  async importContactsFromCsv(
    tenant: TenantContext,
    csvText: string,
    options: CsvImportOptions = {},
  ): Promise<Result<ContactImportRun>> {
    const startedAt = this.clock();

    const tableResult = parseCsvTable(csvText);
    if (!tableResult.ok) return tableResult;

    const existingContacts = await this.repository.listAll(tenant);
    const planResult = planContactImport(tableResult.value, existingContacts, {
      defaultCountry: options.defaultCountry ?? "IN",
    });
    if (!planResult.ok) return planResult;
    const plan = planResult.value;

    let createdCount = 0;
    for (const row of plan.toCreate) {
      const nowIso = this.clock().toISOString();
      const input: NewContactInput = {
        phoneNumber: row.phone,
        displayName: row.displayName,
        email: row.email,
        company: row.company,
        ...(row.requestedDoNotContact
          ? {
              consentState: "do_not_contact" as const,
              optedOutAt: nowIso,
              optOutSource: "import" as const,
              optOutEvidence: `csv-import-row-${row.rowNumber}`,
            }
          : {}),
      };
      const created = await this.repository.create(tenant, input);
      createdCount += 1;
      await this.applyTagsAndCustomFields(tenant, created.id, row.tags, row.customFields);
    }

    let updatedCount = 0;
    for (const row of plan.toUpdate) {
      if (Object.keys(row.profileChanges).length > 0) {
        await this.repository.updateProfile(tenant, row.existing.id, row.profileChanges);
      }
      updatedCount += 1;
      await this.applyTagsAndCustomFields(tenant, row.existing.id, row.tags, row.customFields);
    }

    const rejectedRows: readonly RejectedImportRowRecord[] = plan.rejected.map((r) => ({
      rowNumber: r.rowNumber,
      reason: r.reason,
    }));

    const run = await this.repository.recordImportRun(tenant, {
      startedAt: startedAt.toISOString(),
      finishedAt: this.clock().toISOString(),
      totalRows: plan.totalDataRows,
      createdCount,
      updatedCount,
      rejectedRows,
      actorUserId: options.actorUserId ?? null,
    });
    return ok(run);
  }

  private async applyTagsAndCustomFields(
    tenant: TenantContext,
    contactId: ContactId,
    tags: readonly string[],
    customFields: ReadonlyMap<string, { readonly label: string; readonly raw: string }>,
  ): Promise<void> {
    if (tags.length > 0) {
      await this.assignTagsToContact(tenant, contactId, tags);
    }
    if (customFields.size > 0) {
      await this.setContactCustomFieldValues(tenant, contactId, customFields);
    }
  }
}

function toPagedResult<T>(result: Page<T>, page: PageRequest): PagedResult<T> {
  const range = paginationRange(result.total, page.page, page.pageSize, result.items.length);
  return {
    items: result.items,
    page: page.page,
    pageSize: page.pageSize,
    total: result.total,
    totalPages: range.totalPages,
    hasPrevious: range.hasPrevious,
    hasNext: range.hasNext,
  };
}

function toConsentRecord(contact: ContactRecord): ConsentRecord {
  return {
    state: contact.consentState,
    optedOutAt: contact.optedOutAt ? new Date(contact.optedOutAt) : undefined,
    source: contact.optOutSource ?? undefined,
    evidence: contact.optOutEvidence ?? undefined,
    scope: contact.optOutScope,
  };
}

function toDeliverabilityRecord(contact: ContactRecord): DeliverabilityRecord {
  return {
    state: contact.deliverabilityState,
    suppressedAt: contact.suppressedAt ? new Date(contact.suppressedAt) : undefined,
    suppressedReasonCode: contact.suppressedReasonCode ?? undefined,
    suppressionStrikes: contact.suppressionStrikes,
  };
}
