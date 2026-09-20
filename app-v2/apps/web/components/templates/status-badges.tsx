import type { TemplateApprovalStatus, TemplateCategory } from "@packages/contracts/src/common/vocab";
import { Badge } from "@/components/ui/badge";
import {
  TEMPLATE_CATEGORY_LABEL,
  TEMPLATE_STATUS_EXPLANATION,
  TEMPLATE_STATUS_LABEL,
  TEMPLATE_STATUS_VARIANT,
} from "@/lib/template-status";

/**
 * Pure rendering shell — the label/tone/explanation decisions live in
 * `lib/template-status.ts` (and are tested there) per the "vitest has no
 * React harness" rule in `apps/web/AGENTS.md`.
 */
export function TemplateStatusBadge({ status }: { status: TemplateApprovalStatus }) {
  return (
    <Badge variant={TEMPLATE_STATUS_VARIANT[status]} title={TEMPLATE_STATUS_EXPLANATION[status]}>
      {TEMPLATE_STATUS_LABEL[status]}
    </Badge>
  );
}

export function TemplateCategoryBadge({ category }: { category: TemplateCategory }) {
  return <Badge variant="outline">{TEMPLATE_CATEGORY_LABEL[category]}</Badge>;
}
