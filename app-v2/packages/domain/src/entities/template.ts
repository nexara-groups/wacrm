import type { AccountId, TemplateId } from "../ids";
import type { ISODateString } from "./common";

/** Meta's WhatsApp template categories. */
export type TemplateCategory = "marketing" | "utility" | "authentication";

/** Meta's template review lifecycle, per META_ERROR_TAXONOMY.md §3 (132001/132015/132016). */
export type TemplateApprovalStatus = "pending" | "approved" | "rejected" | "paused" | "disabled";

export interface Template {
  readonly id: TemplateId;
  readonly accountId: AccountId;
  readonly name: string;
  /** BCP-47 / Meta locale code, e.g. "en_US", "hi". */
  readonly language: string;
  readonly category: TemplateCategory;
  readonly status: TemplateApprovalStatus;
  readonly bodyText: string;
  /** Number of `{{n}}` placeholders in `bodyText` — used to validate send-time parameter counts (132000). */
  readonly variableCount: number;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}
