/**
 * Demo data for the broadcasts slice.
 *
 * One approved message template (so the composer's template picker has
 * something to show) and three broadcasts covering the three states the
 * screens need to render for real: a `draft` (nothing sent, editable), a
 * `scheduled` one (waiting on `scheduledAt`), and a finished `sent` one
 * with a real mix of recipient outcomes — including a `PERMANENT_NUMBER`
 * failure, so the "will not be retried" rendering on the report screen is
 * backed by actual data rather than a hypothetical.
 *
 * Written entirely through the repositories (`BroadcastRepositoryPort`,
 * `BroadcastRecipientRepositoryPort`, `MessageTemplateRepositoryPort`,
 * `ContactRepository`) — the same discipline as ./contacts.ts. The finished
 * broadcast's recipient outcomes are applied via `applyOutcome`/
 * `recordAudience`/`incrementCounts`/`updateStatus` exactly as the real
 * send loop (`BroadcastService.processDueRecipients`) would have left them,
 * never a raw insert of a "final" status.
 */
import type { AccountId, ContactId, UserId } from "@packages/domain/src/ids";
import type { PhoneNumber } from "@packages/domain";
import type { RecipientOutcomeUpdate } from "@modules/broadcasts/application/ports";
import type { SeedContext } from "./types";

const TEMPLATE_META_ID = "seed_promo_offer";
const TEMPLATE_BODY = "Hi {{1}}, enjoy 20% off your next order with code {{2}}. Reply STOP to opt out.";

// The PERMANENT_NUMBER entry actually used by modules/messaging-errors'
// classifier for Meta code 131026 (see meta-error-codes.ts) — copied
// verbatim so the seeded failure reads exactly like a real one would.
const PERMANENT_NUMBER_ERROR_CODE = "131026";
const PERMANENT_NUMBER_LAYMAN_MESSAGE =
  "This number isn't on WhatsApp, or can't receive messages. We've stopped sending to it.";

export async function seedBroadcasts({ repositories, tenant, ownerUserId, now }: SeedContext): Promise<void> {
  const accountId = tenant.tenantId as AccountId;
  const createdBy = ownerUserId as UserId;

  const template = await repositories.messageTemplates.upsert({
    accountId,
    metaTemplateId: TEMPLATE_META_ID,
    name: "seed_promo_offer",
    language: "en_US",
    category: "marketing",
    status: "approved",
    bodyText: TEMPLATE_BODY,
    variableCount: 2,
    components: [{ type: "BODY", text: TEMPLATE_BODY }],
  });

  // -- draft -----------------------------------------------------------
  await repositories.broadcasts.create({
    accountId,
    name: "September re-engagement",
    templateId: template.id,
    createdBy,
    scheduledAt: null,
  });

  // -- scheduled ---------------------------------------------------------
  const scheduledAt = new Date(new Date(now).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const scheduled = await repositories.broadcasts.create({
    accountId,
    name: "Festive season preview",
    templateId: template.id,
    createdBy,
    scheduledAt,
  });
  await repositories.broadcasts.updateStatus(accountId, scheduled.id, "scheduled");

  // -- finished (sent), with a real mix of recipient outcomes ------------
  const finished = await repositories.broadcasts.create({
    accountId,
    name: "August 20%-off blast",
    templateId: template.id,
    createdBy,
    scheduledAt: null,
  });

  // Reuse seeded contacts (seedContacts runs before this seeder) so the
  // PERMANENT_NUMBER recipient below lines up with a contact the contacts
  // screen already shows as suppressed for the same Meta code.
  const [delivered1, delivered2, sentOnly, permanentFailure] = await Promise.all([
    repositories.contacts.findByPhone(tenant, "+919876543210" as PhoneNumber), // Asha Reddy
    repositories.contacts.findByPhone(tenant, "+919800000005" as PhoneNumber), // Divya Menon
    repositories.contacts.findByPhone(tenant, "+919800000004" as PhoneNumber), // Karthik Raman
    repositories.contacts.findByPhone(tenant, "+919800000001" as PhoneNumber), // Priya Sharma (already suppressed, 131026)
  ]);
  const recipientContacts = [delivered1, delivered2, sentOnly, permanentFailure].filter(
    (contact): contact is NonNullable<typeof contact> => contact !== null,
  );

  await repositories.broadcastRecipients.createMany(
    recipientContacts.map((contact) => ({ accountId, broadcastId: finished.id, contactId: contact.id })),
  );

  const { items: recipients } = await repositories.broadcastRecipients.listByBroadcast(accountId, finished.id, null, 50);
  const recipientByContact = new Map<ContactId, (typeof recipients)[number]>(
    recipients.map((r) => [r.contactId, r]),
  );

  async function applyIfPresent(
    contactId: ContactId | undefined,
    update: RecipientOutcomeUpdate,
  ): Promise<void> {
    if (!contactId) return;
    const recipient = recipientByContact.get(contactId);
    if (!recipient) return;
    await repositories.broadcastRecipients.applyOutcome(accountId, recipient.id, update);
  }

  await applyIfPresent(delivered1?.id, {
    status: "delivered",
    errorCode: null,
    errorMessage: null,
    disposition: null,
    attemptCount: 1,
    nextAttemptAt: null,
    wamid: "wamid.seed.delivered.1",
    sentAt: now,
    deliveredAt: now,
  });
  await applyIfPresent(delivered2?.id, {
    status: "read",
    errorCode: null,
    errorMessage: null,
    disposition: null,
    attemptCount: 1,
    nextAttemptAt: null,
    wamid: "wamid.seed.delivered.2",
    sentAt: now,
    deliveredAt: now,
    readAt: now,
  });
  await applyIfPresent(sentOnly?.id, {
    status: "sent",
    errorCode: null,
    errorMessage: null,
    disposition: null,
    attemptCount: 1,
    nextAttemptAt: null,
    wamid: "wamid.seed.sent.1",
    sentAt: now,
  });
  await applyIfPresent(permanentFailure?.id, {
    status: "failed",
    errorCode: PERMANENT_NUMBER_ERROR_CODE,
    errorMessage: PERMANENT_NUMBER_LAYMAN_MESSAGE,
    disposition: "PERMANENT_NUMBER",
    attemptCount: 1,
    nextAttemptAt: null,
  });

  const sentBucket = recipientContacts.length - (permanentFailure ? 1 : 0);
  await repositories.broadcasts.recordAudience(accountId, finished.id, recipientContacts.length, 2);
  await repositories.broadcasts.incrementCounts(accountId, finished.id, {
    sent: sentBucket,
    failed: permanentFailure ? 1 : 0,
  });
  await repositories.broadcasts.updateStatus(accountId, finished.id, "sent");
}
