/**
 * Status -> label/tone/explanation mapping for `TemplateApprovalStatus`
 * (`packages/contracts/src/common/vocab.ts`), pulled out of the badge
 * component so the decision table has a plain `.ts` test next to it (see
 * `apps/web/AGENTS.md`'s testing note: vitest here has no React harness, so
 * anything with a decision in it lives outside the `.tsx`).
 *
 * The labels are deliberately not Meta's own vocabulary — an operator
 * looking at a failed send (`template_not_approved`) needs to know what to
 * DO about each status, not what Meta calls it internally. See
 * META_ERROR_TAXONOMY.md §3/§4b, which `templateApprovalStatusViewSchema`
 * also defers to for the same reason.
 */
import type { TemplateApprovalStatus, TemplateCategory } from "@packages/contracts/src/common/vocab";
import type { BadgeProps } from "@/components/ui/badge";

export const TEMPLATE_STATUS_LABEL: Record<TemplateApprovalStatus, string> = {
  approved: "Approved",
  pending: "Pending review",
  rejected: "Rejected",
  paused: "Paused",
  disabled: "Disabled",
};

export const TEMPLATE_STATUS_VARIANT: Record<TemplateApprovalStatus, BadgeProps["variant"]> = {
  approved: "success",
  pending: "outline",
  rejected: "destructive",
  paused: "warning",
  disabled: "destructive",
};

/**
 * One sentence explaining, in operator terms, why a send using this
 * template would (or wouldn't) work right now. Shown as the badge's title
 * so it surfaces on hover without cluttering the row — same idea as
 * `DeliverabilityBadge`'s `reasonCode` title in
 * `components/contacts/status-badges.tsx`.
 */
export const TEMPLATE_STATUS_EXPLANATION: Record<TemplateApprovalStatus, string> = {
  approved: "Approved by Meta — this template can be used to send messages.",
  pending: "Still waiting on Meta's review — cannot be used to send until approved.",
  rejected: "Meta rejected this template's content — edit and resubmit it before it can send.",
  paused: "Meta paused this template over quality (too many negative recipient signals) — sending is blocked until it recovers or is edited.",
  disabled: "Meta disabled this template — it can no longer be used to send and needs to be recreated.",
};

/** Whether a send using this template would currently succeed. */
export function isSendable(status: TemplateApprovalStatus): boolean {
  return status === "approved";
}

export const TEMPLATE_CATEGORY_LABEL: Record<TemplateCategory, string> = {
  marketing: "Marketing",
  utility: "Utility",
  authentication: "Authentication",
};
