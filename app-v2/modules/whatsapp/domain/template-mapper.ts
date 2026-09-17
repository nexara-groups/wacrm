/**
 * Pure mapping from Meta's raw template shape (`MetaTemplateRecord`, as
 * returned by the Business Management API) down to this app's own
 * vocabulary (`TemplateCategory` / `TemplateApprovalStatus` from
 * `packages/domain`, reused rather than redefined per AGENTS instructions).
 *
 * Vendor-free: no fetch, no SDK. Exists so "template CRUD maps Meta
 * responses correctly" is testable without a network call, and so the
 * mapping rules live in exactly one place `infrastructure/` and
 * `application/` both call into.
 */
import type { TemplateApprovalStatus, TemplateCategory } from "../../../packages/domain/src/entities/template";
import type { MetaTemplateDefinitionComponent, MetaTemplateRecord } from "./whatsapp-provider.interface";

/** Meta's `category` string -> our vocabulary. Unrecognised values fall
 *  back to `"utility"` (the least presumptuous category — never assume
 *  `"marketing"`, which carries opt-out/consent implications). */
export function mapTemplateCategory(raw: string): TemplateCategory {
  switch (raw.toUpperCase()) {
    case "MARKETING":
      return "marketing";
    case "AUTHENTICATION":
      return "authentication";
    case "UTILITY":
      return "utility";
    default:
      return "utility";
  }
}

/** Meta's `status` string -> our vocabulary. Unrecognised values fall back
 *  to `"pending"` — never silently mark an unknown status as `"approved"`. */
export function mapTemplateStatus(raw: string): TemplateApprovalStatus {
  switch (raw.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "DISABLED":
      return "disabled";
    case "PENDING":
    case "IN_APPEAL":
      return "pending";
    default:
      return "pending";
  }
}

/** Extracts the `BODY` component's text, `""` when the template has none
 *  (malformed template on Meta's side — treated as empty, not thrown). */
export function extractBodyText(components: readonly MetaTemplateDefinitionComponent[]): string {
  const body = components.find((c) => c.type === "BODY");
  return body?.text ?? "";
}

/** Meta's placeholder syntax is `{{1}}`, `{{2}}`, ... (1-indexed, no gaps
 *  guaranteed) — counts the number of DISTINCT placeholders referenced, not
 *  the highest index, so a template that (incorrectly) skips `{{2}}` still
 *  reports the count actually present rather than a number one send call
 *  cannot possibly satisfy. */
export function countVariables(bodyText: string): number {
  const matches = bodyText.match(/\{\{\s*\d+\s*\}\}/g);
  if (!matches) return 0;
  return new Set(matches).size;
}

/** The subset of `packages/domain` `Template` fields this module can derive
 *  purely from Meta's response — `id`/`accountId`/timestamps are assigned
 *  by the repository layer on persist, not here. */
export interface MappedTemplateFields {
  readonly metaTemplateId: string;
  readonly name: string;
  readonly language: string;
  readonly category: TemplateCategory;
  readonly status: TemplateApprovalStatus;
  readonly bodyText: string;
  readonly variableCount: number;
  readonly components: readonly MetaTemplateDefinitionComponent[];
}

export function mapMetaTemplate(record: MetaTemplateRecord): MappedTemplateFields {
  const bodyText = extractBodyText(record.components);
  return {
    metaTemplateId: record.id,
    name: record.name,
    language: record.language,
    category: mapTemplateCategory(record.category),
    status: mapTemplateStatus(record.status),
    bodyText,
    variableCount: countVariables(bodyText),
    components: record.components,
  };
}
