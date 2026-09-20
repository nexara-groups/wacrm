/**
 * Maps the persistence-layer `ContactRecord` (`@modules/contacts`) onto the
 * wire `Contact` shape (`@packages/contracts`). Kept as one small function
 * so the two never drift apart silently — a field added to one and not the
 * other fails `contactSchema.parse` immediately instead of shipping a
 * response with a field quietly missing.
 *
 * `tags` has no persistence-layer equivalent wired up yet on this record
 * (see `ContactRepository.listTagIdsForContact` — a separate call this
 * screen doesn't need); contracts models it with `.default([])`, so an
 * empty array here is a real, schema-legal value, not a stand-in.
 */
import { contactSchema, type Contact } from "@packages/contracts/src/contacts";
import type { ContactRecord } from "@modules/contacts/application/ports";

export function toContactDTO(record: ContactRecord): Contact {
  return contactSchema.parse({
    id: record.id,
    accountId: record.accountId,
    phoneNumber: record.phoneNumber,
    displayName: record.displayName,
    email: record.email,
    tags: [],
    consentState: record.consentState,
    optedOutAt: record.optedOutAt,
    optOutSource: record.optOutSource,
    optOutEvidence: record.optOutEvidence,
    optOutScope: record.optOutScope,
    deliverabilityState: record.deliverabilityState,
    suppressedAt: record.suppressedAt,
    suppressedReasonCode: record.suppressedReasonCode,
    suppressionStrikes: record.suppressionStrikes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
