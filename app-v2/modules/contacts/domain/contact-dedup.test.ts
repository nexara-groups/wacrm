import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@shared/result";
import { parsePhoneNumber } from "../../../packages/domain/src/phone-number";
import {
  findContactByRawPhone,
  findDuplicateContacts,
  resolveDedupKey,
  type HasPhoneNumber,
} from "./contact-dedup";

interface FakeContact extends HasPhoneNumber {
  readonly id: string;
}

function contact(id: string, rawPhone: string): FakeContact {
  return { id, phoneNumber: parsePhoneNumber(rawPhone) };
}

describe("resolveDedupKey", () => {
  it("normalises two different spellings of the same Indian number to the same key", () => {
    const a = resolveDedupKey("9876543210");
    const b = resolveDedupKey("+91 98765 43210");
    expect(isOk(a)).toBe(true);
    expect(isOk(b)).toBe(true);
    if (isOk(a) && isOk(b)) {
      expect(a.value).toBe(b.value);
    }
  });

  it("rejects an invalid phone number with a Result, not a throw", () => {
    const result = resolveDedupKey("not-a-phone");
    expect(isErr(result)).toBe(true);
  });
});

describe("findContactByRawPhone", () => {
  it("finds an existing contact regardless of how the phone is spelled", () => {
    const contacts = [contact("c1", "+919876543210"), contact("c2", "+14155550123")];
    const found = findContactByRawPhone(contacts, "09876543210");
    expect(found?.id).toBe("c1");
  });

  it("returns undefined for an unmatched phone", () => {
    const contacts = [contact("c1", "+919876543210")];
    expect(findContactByRawPhone(contacts, "+919999999999")).toBeUndefined();
  });

  it("returns undefined for an unparseable raw phone", () => {
    const contacts = [contact("c1", "+919876543210")];
    expect(findContactByRawPhone(contacts, "garbage")).toBeUndefined();
  });
});

describe("findDuplicateContacts", () => {
  it("groups two spellings of one number into a single dedup group", () => {
    const c1 = contact("c1", "9876543210");
    const c2 = contact("c2", "+91-98765-43210");
    const c3 = contact("c3", "+14155550123");
    const groups = findDuplicateContacts([c1, c2, c3]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.canonical.id).toBe("c1");
    expect(groups[0]!.duplicates.map((d) => d.id)).toEqual(["c2"]);
  });

  it("finds no groups when every phone is distinct", () => {
    const groups = findDuplicateContacts([contact("c1", "9876543210"), contact("c2", "+14155550123")]);
    expect(groups).toHaveLength(0);
  });
});
