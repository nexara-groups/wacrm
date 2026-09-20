import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@shared/result";
import { mergeCustomFieldValues, slugifyFieldKey, validateCustomFieldValue } from "./custom-fields";
import type { CustomFieldId } from "./custom-fields";
import type { ContactId } from "../../../packages/domain/src/ids";

const fieldId = (s: string) => s as CustomFieldId;
const contactId = (s: string) => s as ContactId;

describe("slugifyFieldKey", () => {
  it("lowercases and underscores a label", () => {
    expect(slugifyFieldKey("Loyalty Tier")).toBe("loyalty_tier");
  });

  it("collapses punctuation and trims edges", () => {
    expect(slugifyFieldKey("  Pin-Code!! ")).toBe("pin_code");
  });
});

describe("validateCustomFieldValue", () => {
  it("accepts a text value as-is", () => {
    const result = validateCustomFieldValue({ type: "text", label: "Notes", options: null }, "VIP customer");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual({ type: "text", value: "VIP customer" });
  });

  it("coerces a numeric string", () => {
    const result = validateCustomFieldValue({ type: "number", label: "Age", options: null }, "42");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual({ type: "number", value: 42 });
  });

  it("rejects a non-numeric string with a layman message", () => {
    const result = validateCustomFieldValue({ type: "number", label: "Age", options: null }, "not-a-number");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.message).not.toMatch(/NaN|parseInt|regex/i);
    }
  });

  it("coerces common boolean spellings", () => {
    for (const [raw, expected] of [
      ["yes", true],
      ["No", false],
      ["1", true],
      ["0", false],
    ] as const) {
      const result = validateCustomFieldValue({ type: "boolean", label: "Subscribed", options: null }, raw);
      expect(isOk(result)).toBe(true);
      if (isOk(result)) expect(result.value.value).toBe(expected);
    }
  });

  it("rejects an unparseable date", () => {
    const result = validateCustomFieldValue({ type: "date", label: "Anniversary", options: null }, "not-a-date");
    expect(isErr(result)).toBe(true);
  });

  it("accepts a valid date and normalises to ISO", () => {
    const result = validateCustomFieldValue({ type: "date", label: "Anniversary", options: null }, "2026-01-15");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.value).toBe(new Date("2026-01-15").toISOString());
  });

  it("rejects a select value outside its options", () => {
    const result = validateCustomFieldValue(
      { type: "select", label: "Tier", options: ["gold", "silver"] },
      "platinum",
    );
    expect(isErr(result)).toBe(true);
  });

  it("accepts a select value within its options", () => {
    const result = validateCustomFieldValue(
      { type: "select", label: "Tier", options: ["gold", "silver"] },
      "gold",
    );
    expect(isOk(result)).toBe(true);
  });
});

describe("mergeCustomFieldValues", () => {
  it("replaces a value with a matching fieldId and keeps the rest", () => {
    const cid = contactId("11111111-1111-4111-8111-111111111111");
    const existing = [
      { contactId: cid, fieldId: fieldId("f1"), value: { type: "text" as const, value: "old" } },
      { contactId: cid, fieldId: fieldId("f2"), value: { type: "text" as const, value: "keep" } },
    ];
    const updates = [
      { contactId: cid, fieldId: fieldId("f1"), value: { type: "text" as const, value: "new" } },
    ];
    const merged = mergeCustomFieldValues(existing, updates);
    expect(merged).toHaveLength(2);
    expect(merged.find((v) => v.fieldId === fieldId("f1"))?.value).toEqual({ type: "text", value: "new" });
    expect(merged.find((v) => v.fieldId === fieldId("f2"))?.value).toEqual({ type: "text", value: "keep" });
  });

  it("appends a new field not present in existing", () => {
    const cid = contactId("11111111-1111-4111-8111-111111111111");
    const merged = mergeCustomFieldValues(
      [],
      [{ contactId: cid, fieldId: fieldId("f3"), value: { type: "number" as const, value: 5 } }],
    );
    expect(merged).toHaveLength(1);
  });
});
