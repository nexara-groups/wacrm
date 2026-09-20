import { describe, expect, it } from "vitest";
import type { TemplateApprovalStatus, TemplateCategory } from "@packages/contracts/src/common/vocab";
import {
  isSendable,
  TEMPLATE_CATEGORY_LABEL,
  TEMPLATE_STATUS_EXPLANATION,
  TEMPLATE_STATUS_LABEL,
  TEMPLATE_STATUS_VARIANT,
} from "./template-status";

const ALL_STATUSES: readonly TemplateApprovalStatus[] = ["approved", "pending", "rejected", "paused", "disabled"];
const ALL_CATEGORIES: readonly TemplateCategory[] = ["marketing", "utility", "authentication"];

describe("template status mapping", () => {
  it("has a label, a variant and an explanation for every approval status", () => {
    for (const status of ALL_STATUSES) {
      expect(TEMPLATE_STATUS_LABEL[status]).toBeTruthy();
      expect(TEMPLATE_STATUS_VARIANT[status]).toBeTruthy();
      expect(TEMPLATE_STATUS_EXPLANATION[status]).toBeTruthy();
    }
  });

  it("has a label for every template category", () => {
    for (const category of ALL_CATEGORIES) {
      expect(TEMPLATE_CATEGORY_LABEL[category]).toBeTruthy();
    }
  });

  it("only 'approved' is sendable", () => {
    expect(isSendable("approved")).toBe(true);
    for (const status of ALL_STATUSES) {
      if (status === "approved") continue;
      expect(isSendable(status)).toBe(false);
    }
  });

  it("gives rejected, paused and disabled visibly distinct treatment from pending", () => {
    // Rejected/paused/disabled all mean "cannot send" but for different
    // reasons — none of them should collapse onto pending's tone or wording.
    expect(TEMPLATE_STATUS_VARIANT.rejected).not.toBe(TEMPLATE_STATUS_VARIANT.pending);
    expect(TEMPLATE_STATUS_VARIANT.paused).not.toBe(TEMPLATE_STATUS_VARIANT.pending);
    expect(TEMPLATE_STATUS_VARIANT.disabled).not.toBe(TEMPLATE_STATUS_VARIANT.pending);

    const labels = new Set(ALL_STATUSES.map((status) => TEMPLATE_STATUS_LABEL[status]));
    expect(labels.size).toBe(ALL_STATUSES.length);

    const explanations = new Set(ALL_STATUSES.map((status) => TEMPLATE_STATUS_EXPLANATION[status]));
    expect(explanations.size).toBe(ALL_STATUSES.length);
  });
});
