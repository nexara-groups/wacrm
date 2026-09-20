import type { AccountId, ContactId } from "../ids";
import type { PhoneNumber } from "../phone-number";
import type { ConsentState } from "../status/consent-state";
import type { DeliverabilityState } from "../status/deliverability-state";
import type { ISODateString } from "./common";

/** Mirrors `opt_out_source` — META_ERROR_TAXONOMY.md §3b. */
export type OptOutSource = "keyword" | "quick_reply" | "inferred_block" | "operator" | "import";

/**
 * Category scoping is designed for but not built (§3b): "opt out of
 * marketing but still receive order updates" is future work. `"all"` is the
 * only value today.
 */
export type OptOutScope = "all";

export interface Contact {
  readonly id: ContactId;
  readonly accountId: AccountId;
  readonly phoneNumber: PhoneNumber;
  readonly displayName: string | null;
  readonly email: string | null;

  readonly consentState: ConsentState;
  readonly optedOutAt: ISODateString | null;
  readonly optOutSource: OptOutSource | null;
  /** The inbound message id (or import row ref) evidencing the opt-out/re-opt-in, for disputes (§3b). */
  readonly optOutEvidence: string | null;
  readonly optOutScope: OptOutScope;

  readonly deliverabilityState: DeliverabilityState;
  readonly suppressedAt: ISODateString | null;
  /** e.g. "131026" — the Meta error code that caused suppression (§4). */
  readonly suppressedReasonCode: string | null;
  readonly suppressionStrikes: number;

  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}
