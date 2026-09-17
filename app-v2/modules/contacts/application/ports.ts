/**
 * ContactRepository — the persistence PORT the application layer depends
 * on. Interface only: no SQL, no vendor SDK, no `core/database` import (the
 * architecture guard enforces this for everything under `modules/`).
 * `infrastructure/contact-repository.ts` implements this against
 * `DatabaseProvider`.
 *
 * Reuses `Contact`, `ContactId`, `PhoneNumber`, `ConsentState`,
 * `DeliverabilityState` and `OptOutSource` from `packages/domain` rather
 * than redefining them — see this module's build instructions. `Contact`
 * itself has no `company` field (that is a contacts-module-only concept),
 * so `ContactRecord` below is `Contact` extended with it, not a
 * reimplementation.
 */
import type { TenantContext } from "@nexara/core/context";
import type { UserId } from "@shared/types";
import type { Contact, OptOutSource, OptOutScope } from "../../../packages/domain/src/entities/contact";
import type { ContactId } from "../../../packages/domain/src/ids";
import type { PhoneNumber } from "../../../packages/domain/src/phone-number";
import type { ConsentState } from "../../../packages/domain/src/status/consent-state";
import type { DeliverabilityState } from "../../../packages/domain/src/status/deliverability-state";
import type {
  ContactCustomFieldValue,
  CustomFieldDefinition,
  CustomFieldId,
  CustomFieldType,
} from "../domain/custom-fields";
import type { Tag, TagFilter, TagId } from "../domain/tags";

/** `Contact` plus this module's own CRM fields not modeled on the shared entity. */
export interface ContactRecord extends Contact {
  readonly company: string | null;
}

export interface NewContactInput {
  readonly phoneNumber: PhoneNumber;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly company: string | null;
  /** Initial consent state for a BRAND NEW contact only — see csv-import.ts's
   *  docstring for why this is never used to change an existing contact's
   *  consent. Defaults to `"unknown"`. */
  readonly consentState?: ConsentState;
  readonly optedOutAt?: string | null;
  readonly optOutSource?: OptOutSource | null;
  readonly optOutEvidence?: string | null;
  readonly optOutScope?: OptOutScope;
}

export interface ContactProfilePatch {
  readonly displayName?: string | null;
  readonly email?: string | null;
  readonly company?: string | null;
}

/** The full set of consent columns, written atomically together — never partially. */
export interface ConsentPatch {
  readonly state: ConsentState;
  readonly optedOutAt: string | null;
  readonly source: OptOutSource | null;
  readonly evidence: string | null;
  readonly scope: OptOutScope;
}

/** The full set of deliverability columns, written atomically together. */
export interface DeliverabilityPatch {
  readonly state: DeliverabilityState;
  readonly suppressedAt: string | null;
  readonly suppressedReasonCode: string | null;
  readonly suppressionStrikes: number;
}

export interface PageRequest {
  readonly page: number;
  readonly pageSize: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface ContactSearchFilter {
  /** Free-text match against name / email / company / phone. */
  readonly query?: string;
  readonly consentState?: ConsentState;
  readonly deliverabilityState?: DeliverabilityState;
  readonly tagFilter?: TagFilter;
}

export interface RejectedImportRowRecord {
  readonly rowNumber: number;
  readonly reason: string;
}

export interface NewContactImportRun {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly totalRows: number;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly rejectedRows: readonly RejectedImportRowRecord[];
  readonly actorUserId: UserId | null;
}

export interface ContactImportRun extends NewContactImportRun {
  readonly id: string;
  readonly accountId: string;
}

export interface ContactRepository {
  create(tenant: TenantContext, input: NewContactInput): Promise<ContactRecord>;
  findById(tenant: TenantContext, contactId: ContactId): Promise<ContactRecord | null>;
  findByPhone(tenant: TenantContext, phone: PhoneNumber): Promise<ContactRecord | null>;
  /** Every contact for this account — used for CSV-import phone matching and dedup audits. */
  listAll(tenant: TenantContext): Promise<readonly ContactRecord[]>;
  updateProfile(
    tenant: TenantContext,
    contactId: ContactId,
    patch: ContactProfilePatch,
  ): Promise<ContactRecord | null>;
  /** Persists a full consent state change. Callers (ContactService) are
   *  responsible for having already validated the transition via
   *  `canTransitionConsentState` — this method just writes it. */
  applyConsentPatch(
    tenant: TenantContext,
    contactId: ContactId,
    patch: ConsentPatch,
  ): Promise<ContactRecord | null>;
  applyDeliverabilityPatch(
    tenant: TenantContext,
    contactId: ContactId,
    patch: DeliverabilityPatch,
  ): Promise<ContactRecord | null>;
  delete(tenant: TenantContext, contactId: ContactId): Promise<void>;
  search(
    tenant: TenantContext,
    filter: ContactSearchFilter,
    page: PageRequest,
  ): Promise<Page<ContactRecord>>;

  // Tags
  listTags(tenant: TenantContext): Promise<readonly Tag[]>;
  /** Case/whitespace-insensitive get-or-create, keyed by `canonicalTagKey` (domain/tags.ts). */
  findOrCreateTagsByName(tenant: TenantContext, names: readonly string[]): Promise<readonly Tag[]>;
  assignTags(tenant: TenantContext, contactId: ContactId, tagIds: readonly TagId[]): Promise<void>;
  listTagIdsForContact(tenant: TenantContext, contactId: ContactId): Promise<readonly TagId[]>;

  // Custom fields
  listCustomFieldDefinitions(tenant: TenantContext): Promise<readonly CustomFieldDefinition[]>;
  findOrCreateCustomFieldDefinition(
    tenant: TenantContext,
    key: string,
    label: string,
    type: CustomFieldType,
  ): Promise<CustomFieldDefinition>;
  getCustomFieldValues(
    tenant: TenantContext,
    contactId: ContactId,
  ): Promise<readonly ContactCustomFieldValue[]>;
  setCustomFieldValues(
    tenant: TenantContext,
    contactId: ContactId,
    values: readonly ContactCustomFieldValue[],
  ): Promise<void>;

  // Import audit
  recordImportRun(tenant: TenantContext, run: NewContactImportRun): Promise<ContactImportRun>;
}

export type { CustomFieldId };
