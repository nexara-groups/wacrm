/**
 * Demo contacts.
 *
 * Covers every consent x deliverability combination the contacts screen can
 * render, not just the happy path — those two axes are the whole point of
 * the row (see META_ERROR_TAXONOMY.md §3b: consent and deliverability are
 * independent, and only one of them is operator-clearable).
 */
import type { PhoneNumber } from "@packages/domain";
import type { SeedContext } from "./types";

interface SeedRow {
  readonly name: string;
  readonly phone: string;
  readonly consent: "unknown" | "opted_in" | "opted_out" | "do_not_contact";
  readonly deliverability: "unknown" | "reachable" | "suppressed" | "manually_cleared";
  readonly reasonCode: string | null;
}

const SEED: readonly SeedRow[] = [
  { name: "Asha Reddy", phone: "+919876543210", consent: "opted_in", deliverability: "reachable", reasonCode: null },
  { name: "Vikram Nair", phone: "+919812345678", consent: "unknown", deliverability: "unknown", reasonCode: null },
  { name: "Priya Sharma", phone: "+919800000001", consent: "opted_in", deliverability: "suppressed", reasonCode: "131026" },
  { name: "Rahul Desai", phone: "+919800000002", consent: "opted_out", deliverability: "reachable", reasonCode: null },
  { name: "Meena Iyer", phone: "+919800000003", consent: "do_not_contact", deliverability: "reachable", reasonCode: null },
  { name: "Karthik Raman", phone: "+919800000004", consent: "opted_in", deliverability: "manually_cleared", reasonCode: null },
  { name: "Divya Menon", phone: "+919800000005", consent: "unknown", deliverability: "reachable", reasonCode: null },
];

export async function seedContacts({ repositories, tenant, now }: SeedContext): Promise<void> {
  for (const row of SEED) {
    const created = await repositories.contacts.create(tenant, {
      phoneNumber: row.phone as unknown as PhoneNumber,
      displayName: row.name,
      email: null,
      company: null,
      consentState: row.consent,
      ...(row.consent === "opted_out" || row.consent === "do_not_contact"
        ? { optedOutAt: now, optOutSource: "operator", optOutEvidence: "seed data" }
        : {}),
    });
    if (row.deliverability !== "unknown") {
      await repositories.contacts.applyDeliverabilityPatch(tenant, created.id, {
        state: row.deliverability,
        suppressedAt: row.reasonCode === null ? null : now,
        suppressedReasonCode: row.reasonCode,
        suppressionStrikes: row.reasonCode === null ? 0 : 1,
      });
    }
  }
}
