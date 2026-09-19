import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@shared/result";
import { parsePhoneNumber } from "../../../packages/domain/src/phone-number";
import type { ConsentState } from "../../../packages/domain/src/status/consent-state";
import {
  parseCsvRows,
  parseCsvTable,
  planContactImport,
  resolveHeaderMap,
  type ExistingImportContact,
} from "./csv-import";

interface FakeExistingContact extends ExistingImportContact {
  readonly id: string;
}

function existing(id: string, rawPhone: string, consentState: ConsentState): FakeExistingContact {
  return { id, phoneNumber: parsePhoneNumber(rawPhone), consentState };
}

function csv(...lines: string[]): string {
  return lines.join("\n");
}

describe("parseCsvRows", () => {
  it("splits plain comma-separated rows", () => {
    const rows = parseCsvRows("a,b,c\n1,2,3\n");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const rows = parseCsvRows('name,note\n"Doe, John","He said ""hi"""\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["Doe, John", 'He said "hi"'],
    ]);
  });

  it("handles a quoted field with an embedded newline", () => {
    const rows = parseCsvRows('name,note\n"Jane","line1\nline2"\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["Jane", "line1\nline2"],
    ]);
  });

  it("strips a leading UTF-8 BOM", () => {
    const rows = parseCsvRows("﻿phone,name\n+919876543210,Asha\n");
    expect(rows[0]).toEqual(["phone", "name"]);
  });

  it("handles CRLF line endings", () => {
    const rows = parseCsvRows("phone,name\r\n+919876543210,Asha\r\n");
    expect(rows).toEqual([
      ["phone", "name"],
      ["+919876543210", "Asha"],
    ]);
  });
});

describe("parseCsvTable", () => {
  it("numbers data rows starting at 2 (header is row 1)", () => {
    const result = parseCsvTable(csv("phone,name", "+919876543210,Asha", "+14155550123,Bob"));
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.rows.map((r) => r.rowNumber)).toEqual([2, 3]);
    }
  });

  it("rejects a completely empty file", () => {
    expect(isErr(parseCsvTable(""))).toBe(true);
  });

  it("skips trailing blank lines without counting them as data rows", () => {
    const result = parseCsvTable("phone,name\n+919876543210,Asha\n\n");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.rows).toHaveLength(1);
  });
});

describe("resolveHeaderMap", () => {
  it("recognises common header aliases case-insensitively", () => {
    const map = resolveHeaderMap(["Phone Number", "Full Name", "Email", "Company", "DND", "Tags"]);
    expect(map.phoneIndex).toBe(0);
    expect(map.nameIndex).toBe(1);
    expect(map.emailIndex).toBe(2);
    expect(map.companyIndex).toBe(3);
    expect(map.doNotContactIndex).toBe(4);
    expect(map.tagsIndex).toBe(5);
  });

  it("treats unrecognised columns as custom fields", () => {
    const map = resolveHeaderMap(["phone", "Loyalty Tier", "Pin Code"]);
    expect(map.customFieldColumns).toEqual([
      { index: 1, key: "loyalty_tier", label: "Loyalty Tier" },
      { index: 2, key: "pin_code", label: "Pin Code" },
    ]);
  });
});

describe("planContactImport — the consent-preservation guarantee", () => {
  it("THE regression test: re-importing an opted-out contact never re-subscribes them", () => {
    const optedOutContact = existing("c1", "+919876543210", "opted_out");
    const table = parseCsvTable(csv("phone,name,do_not_contact", "9876543210,Asha Updated,false"));
    expect(isOk(table)).toBe(true);
    if (!isOk(table)) return;

    const plan = planContactImport(table.value, [optedOutContact]);
    expect(isOk(plan)).toBe(true);
    if (!isOk(plan)) return;

    expect(plan.value.toCreate).toHaveLength(0);
    expect(plan.value.toUpdate).toHaveLength(1);
    const updateRow = plan.value.toUpdate[0]!;
    expect(updateRow.existing.id).toBe("c1");
    expect(updateRow.existing.consentState).toBe("opted_out"); // untouched reference
    expect(updateRow.profileChanges).toEqual({ displayName: "Asha Updated" });
    // The type itself carries no consent field to apply — assert no such
    // key leaked onto the plain object at runtime either.
    expect(updateRow).not.toHaveProperty("consentState");
    expect(updateRow).not.toHaveProperty("optedOutAt");
    expect(updateRow).not.toHaveProperty("optOutSource");
    expect(updateRow).not.toHaveProperty("optOutEvidence");
    expect(updateRow).not.toHaveProperty("deliverabilityState");
    expect(updateRow).not.toHaveProperty("applyDoNotContact");
  });

  it("re-importing a do_not_contact contact also leaves consent completely alone", () => {
    const dncContact = existing("c2", "+14155550123", "do_not_contact");
    const table = parseCsvTable(csv("phone,name", "+14155550123,Bob Updated"));
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, [dncContact]);
    if (!isOk(plan)) throw new Error("unreachable");
    expect(plan.value.toUpdate).toHaveLength(1);
    expect(plan.value.toUpdate[0]!.existing.consentState).toBe("do_not_contact");
  });

  it("a do_not_contact CSV column only ever applies to a brand-new contact", () => {
    const table = parseCsvTable(csv("phone,name,do_not_contact", "+919999999999,New Guy,yes"));
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, []);
    if (!isOk(plan)) throw new Error("unreachable");
    expect(plan.value.toCreate).toHaveLength(1);
    expect(plan.value.toCreate[0]!.requestedDoNotContact).toBe(true);
  });

  it("re-import of an opted_in contact updates only profile fields, never flips consent", () => {
    const optedIn = existing("c3", "+919876500000", "opted_in");
    const table = parseCsvTable(csv("phone,name,do_not_contact", "9876500000,Carol,true"));
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, [optedIn]);
    if (!isOk(plan)) throw new Error("unreachable");
    expect(plan.value.toUpdate).toHaveLength(1);
    expect(plan.value.toUpdate[0]!.existing.consentState).toBe("opted_in");
    expect(plan.value.toUpdate[0]!).not.toHaveProperty("applyDoNotContact");
  });
});

describe("planContactImport — dedup by phone", () => {
  it("matches an existing contact regardless of how the CSV spells the number (update, not create)", () => {
    const c = existing("c1", "+919876543210", "unknown");
    const table = parseCsvTable(csv("phone,name", "09876543210,Asha"));
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, [c]);
    if (!isOk(plan)) throw new Error("unreachable");
    expect(plan.value.toCreate).toHaveLength(0);
    expect(plan.value.toUpdate).toHaveLength(1);
  });

  it("creates a genuinely new contact when the phone matches nothing existing", () => {
    const table = parseCsvTable(csv("phone,name", "+14155550123,Bob"));
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, []);
    if (!isOk(plan)) throw new Error("unreachable");
    expect(plan.value.toCreate).toHaveLength(1);
    expect(plan.value.toCreate[0]!.phone).toBe(parsePhoneNumber("+14155550123"));
  });
});

describe("planContactImport — malformed and duplicate rows are reported, not dropped", () => {
  it("reports a row with the wrong number of columns, with a reason, and does not silently skip it unnoticed", () => {
    const table = parseCsvTable(csv("phone,name,email", "+919876543210,Asha"));
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, []);
    if (!isOk(plan)) throw new Error("unreachable");
    expect(plan.value.toCreate).toHaveLength(0);
    expect(plan.value.rejected).toHaveLength(1);
    expect(plan.value.rejected[0]!.reason).toMatch(/column/i);
    expect(plan.value.rejected[0]!.rowNumber).toBe(2);
  });

  it("reports duplicate rows within one file, keeping only the first", () => {
    const table = parseCsvTable(
      csv("phone,name", "+919876543210,Asha", "9876543210,Asha Again", "+14155550123,Bob"),
    );
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, []);
    if (!isOk(plan)) throw new Error("unreachable");
    expect(plan.value.toCreate).toHaveLength(2); // Asha (first) + Bob
    expect(plan.value.rejected).toHaveLength(1);
    expect(plan.value.rejected[0]!.rowNumber).toBe(3);
    expect(plan.value.rejected[0]!.reason).toMatch(/row 2/i);
    expect(plan.value.rejected[0]!.reason).toMatch(/same phone number/i);
  });

  it("rejects an invalid phone number with a plain-English reason containing no jargon", () => {
    const table = parseCsvTable(csv("phone,name", "not-a-real-number,Asha"));
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, []);
    if (!isOk(plan)) throw new Error("unreachable");
    expect(plan.value.rejected).toHaveLength(1);
    const reason = plan.value.rejected[0]!.reason;
    expect(reason).not.toMatch(/E\.164|NSN|regex|parse|AppError|VALIDATION|trunk/i);
    expect(reason.toLowerCase()).toContain("phone number");
  });

  it("reports a row with a missing phone cell", () => {
    const table = parseCsvTable(csv("phone,name", ",Asha"));
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, []);
    if (!isOk(plan)) throw new Error("unreachable");
    expect(plan.value.rejected).toHaveLength(1);
    expect(plan.value.rejected[0]!.reason.toLowerCase()).toContain("no phone number");
  });

  it("fails outright when the file has no phone column at all", () => {
    const table = parseCsvTable(csv("name,email", "Asha,asha@example.com"));
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, []);
    expect(isErr(plan)).toBe(true);
  });
});

describe("planContactImport — custom fields and tags", () => {
  it("collects unrecognised columns as custom fields, and a tags column as a list", () => {
    const table = parseCsvTable(csv("phone,name,tags,Loyalty Tier", "+919876543210,Asha,\"VIP,Gold\",Gold"));
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, []);
    if (!isOk(plan)) throw new Error("unreachable");
    const row = plan.value.toCreate[0]!;
    expect(row.tags).toEqual(["VIP", "Gold"]);
    expect(row.customFields.get("loyalty_tier")).toEqual({ label: "Loyalty Tier", raw: "Gold" });
  });

  it("does not create a custom field entry for a blank cell", () => {
    const table = parseCsvTable(csv("phone,name,Loyalty Tier", "+919876543210,Asha,"));
    if (!isOk(table)) throw new Error("unreachable");
    const plan = planContactImport(table.value, []);
    if (!isOk(plan)) throw new Error("unreachable");
    expect(plan.value.toCreate[0]!.customFields.size).toBe(0);
  });
});
