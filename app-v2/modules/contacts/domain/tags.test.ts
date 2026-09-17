import { describe, expect, it } from "vitest";
import {
  canonicalTagKey,
  contactMatchesTagFilter,
  dedupeTagNames,
  filterContactIdsByTags,
  parseTagList,
  type TagId,
} from "./tags";

const tagId = (s: string) => s as TagId;

describe("canonicalTagKey", () => {
  it("treats differing case and spacing as the same tag", () => {
    expect(canonicalTagKey("VIP")).toBe(canonicalTagKey(" vip  "));
    expect(canonicalTagKey("New  Customer")).toBe(canonicalTagKey("new customer"));
  });
});

describe("dedupeTagNames", () => {
  it("drops empties and case-insensitive duplicates, keeping first-seen casing", () => {
    expect(dedupeTagNames(["VIP", " ", "vip", "New"])).toEqual(["VIP", "New"]);
  });
});

describe("parseTagList", () => {
  it("splits a comma-separated cell", () => {
    expect(parseTagList("VIP, Wholesale, vip")).toEqual(["VIP", "Wholesale"]);
  });

  it("splits a semicolon-separated cell", () => {
    expect(parseTagList("VIP;Wholesale")).toEqual(["VIP", "Wholesale"]);
  });

  it("returns an empty list for a blank cell", () => {
    expect(parseTagList("")).toEqual([]);
  });
});

describe("contactMatchesTagFilter", () => {
  const vip = tagId("vip");
  const wholesale = tagId("wholesale");

  it("matches everything when the filter has no tag ids", () => {
    expect(contactMatchesTagFilter([], { tagIds: [], mode: "any" })).toBe(true);
  });

  it("'any' mode matches when at least one tag overlaps", () => {
    expect(contactMatchesTagFilter([vip], { tagIds: [vip, wholesale], mode: "any" })).toBe(true);
  });

  it("'all' mode requires every filter tag to be present", () => {
    expect(contactMatchesTagFilter([vip], { tagIds: [vip, wholesale], mode: "all" })).toBe(false);
    expect(contactMatchesTagFilter([vip, wholesale], { tagIds: [vip, wholesale], mode: "all" })).toBe(true);
  });
});

describe("filterContactIdsByTags", () => {
  it("returns only contacts matching the filter, in map order", () => {
    const vip = tagId("vip");
    const wholesale = tagId("wholesale");
    const assignments = new Map<string, readonly TagId[]>([
      ["c1", [vip]],
      ["c2", [wholesale]],
      ["c3", [vip, wholesale]],
    ]);
    expect(filterContactIdsByTags(assignments, { tagIds: [vip], mode: "any" })).toEqual(["c1", "c3"]);
  });
});
