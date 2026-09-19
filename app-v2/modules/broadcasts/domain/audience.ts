/**
 * Audience selection — META_ERROR_TAXONOMY.md §4 enforcement point 1
 * ("Audience build — broadcast recipient selection excludes
 * deliverability_state = 'suppressed'") and §3b (opted_out / do_not_contact
 * consent states block sends too).
 *
 * THE MOST IMPORTANT FILE IN THIS MODULE, per the build brief: the number
 * shown in the audience preview MUST equal the number that actually sends.
 * That invariant is kept by construction here — `includedContactIds` is
 * exactly `contacts.length - skippedCount`, always, because both numbers
 * come out of the same single pass over the same input (see
 * `audience.test.ts`'s "preview count equals send count" test) — and by
 * `pre-send-guard.ts` re-running the exact same `shouldBlockSend` primitive
 * (not a re-derived copy of the rule) immediately before dispatch.
 *
 * Skipped contacts are returned GROUPED BY REASON, never a flat list — §4b:
 * "3,142 recipients · 180 will be skipped (142 can't receive · 38 opted
 * out)". `formatAudiencePreview` below renders exactly that shape from the
 * structured groups.
 */
import type { Contact } from "@packages/domain/src/entities/contact";
import type { ContactId } from "@packages/domain/src/ids";
import { shouldBlockSend, type BlockReason } from "@modules/messaging-errors/domain/suppression";

/** The three reasons a candidate contact never enters the send list. */
export type AudienceSkipReasonKind = "cannot_receive" | "opted_out" | "do_not_contact";

export interface AudienceSkipReason {
  readonly kind: AudienceSkipReasonKind;
  /** Plain-English label for the preview/report UI (§4b) — no jargon, no Meta codes. */
  readonly label: string;
}

const CANNOT_RECEIVE: AudienceSkipReason = {
  kind: "cannot_receive",
  label: "can't receive WhatsApp messages",
};
const OPTED_OUT: AudienceSkipReason = {
  kind: "opted_out",
  label: "opted out",
};
const DO_NOT_CONTACT: AudienceSkipReason = {
  kind: "do_not_contact",
  label: "marked do-not-contact",
};

/** Fixed, stable ordering — the same order every time, so the preview/report UI never jitters between builds. */
const SKIP_REASONS_IN_ORDER: readonly AudienceSkipReason[] = [CANNOT_RECEIVE, OPTED_OUT, DO_NOT_CONTACT];

function reasonFor(block: BlockReason): AudienceSkipReason {
  switch (block.kind) {
    case "suppressed":
      return CANNOT_RECEIVE;
    case "opted_out":
      return OPTED_OUT;
    case "do_not_contact":
      return DO_NOT_CONTACT;
  }
}

export interface AudienceSkipGroup {
  readonly reason: AudienceSkipReason;
  readonly contactIds: readonly ContactId[];
}

export interface AudienceSelection {
  readonly totalConsidered: number;
  readonly includedContactIds: readonly ContactId[];
  /** Never a flat list of 180 rows — grouped by reason (§4b). Only non-empty groups are present. */
  readonly skipped: readonly AudienceSkipGroup[];
  readonly skippedCount: number;
}

/**
 * Build the send audience from a page of candidate contacts. Pure — the
 * caller (the application layer, via `AudienceSource`) is responsible for
 * fetching the candidate contacts; this function only applies the
 * suppression/consent filter and groups the rejects. Safe to call once per
 * page and merge with `mergeAudienceSelections` — see
 * `application/broadcast-service.ts`'s `previewAudience`.
 */
export function buildAudience(contacts: readonly Contact[]): AudienceSelection {
  const included: ContactId[] = [];
  const buckets = new Map<AudienceSkipReasonKind, ContactId[]>(
    SKIP_REASONS_IN_ORDER.map((reason) => [reason.kind, [] as ContactId[]]),
  );

  for (const contact of contacts) {
    const block = shouldBlockSend(
      contact.deliverabilityState,
      contact.consentState,
      contact.suppressedReasonCode ?? undefined,
    );
    if (block === null) {
      included.push(contact.id);
      continue;
    }
    const reason = reasonFor(block);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- buckets is seeded with every AudienceSkipReasonKind above
    buckets.get(reason.kind)!.push(contact.id);
  }

  return finalizeSelection(contacts.length, included, buckets);
}

function finalizeSelection(
  totalConsidered: number,
  included: readonly ContactId[],
  buckets: ReadonlyMap<AudienceSkipReasonKind, readonly ContactId[]>,
): AudienceSelection {
  const skipped: AudienceSkipGroup[] = [];
  for (const reason of SKIP_REASONS_IN_ORDER) {
    const contactIds = buckets.get(reason.kind) ?? [];
    if (contactIds.length > 0) {
      skipped.push({ reason, contactIds });
    }
  }
  const skippedCount = skipped.reduce((sum, group) => sum + group.contactIds.length, 0);
  return { totalConsidered, includedContactIds: included, skipped, skippedCount };
}

/**
 * Combine per-page `AudienceSelection`s (candidate contacts can number in
 * the thousands — the application layer paginates `AudienceSource` and
 * calls `buildAudience` once per page) into one overall selection, without
 * re-deriving the skip logic — it only concatenates already-classified
 * contact ids, so the merge itself cannot introduce drift between the
 * preview count and what gets enqueued.
 */
export function mergeAudienceSelections(selections: readonly AudienceSelection[]): AudienceSelection {
  const included: ContactId[] = [];
  const buckets = new Map<AudienceSkipReasonKind, ContactId[]>(
    SKIP_REASONS_IN_ORDER.map((reason) => [reason.kind, [] as ContactId[]]),
  );
  let totalConsidered = 0;

  for (const selection of selections) {
    totalConsidered += selection.totalConsidered;
    included.push(...selection.includedContactIds);
    for (const group of selection.skipped) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- buckets is seeded with every AudienceSkipReasonKind above
      buckets.get(group.reason.kind)!.push(...group.contactIds);
    }
  }

  return finalizeSelection(totalConsidered, included, buckets);
}

/**
 * §4b's exact preview shape: "3,142 recipients · 180 will be skipped (142
 * can't receive · 38 opted out)". Kept separate from `buildAudience` so
 * callers/tests can assert on the structured counts without parsing a
 * string, while the UI still gets the literal copy from one place.
 */
export function formatAudiencePreview(selection: AudienceSelection): string {
  const total = selection.totalConsidered.toLocaleString("en-US");
  if (selection.skippedCount === 0) {
    return `${total} recipients`;
  }
  const skippedTotal = selection.skippedCount.toLocaleString("en-US");
  const breakdown = selection.skipped
    .map((group) => `${group.contactIds.length.toLocaleString("en-US")} ${group.reason.label}`)
    .join(" · ");
  return `${total} recipients · ${skippedTotal} will be skipped (${breakdown})`;
}
