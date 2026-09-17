/**
 * Per-account tags, contact-tag assignment, and filter-by-tags. Pure domain
 * module — persistence lives behind `application/ports.ts`'s
 * `ContactRepository`.
 */
import type { Brand } from "../../../packages/domain/src/brand";
import type { AccountId, ContactId } from "../../../packages/domain/src/ids";
import type { ISODateString } from "../../../packages/domain/src/entities/common";

export type TagId = Brand<string, "TagId">;

export interface Tag {
  readonly id: TagId;
  readonly accountId: AccountId;
  /** As the operator typed it — display casing is preserved. */
  readonly name: string;
  readonly color: string | null;
  readonly createdAt: ISODateString;
}

/**
 * Canonical comparison key for a tag name: trims, collapses internal
 * whitespace, and lowercases. Two names that differ only by case/spacing
 * ("VIP", " vip ", "Vip") are the SAME tag — this is what "per-account
 * tags" (not per-account-and-casing) means in practice.
 */
export function canonicalTagKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * De-duplicates a list of raw tag names (e.g. from a CSV "tags" column
 * split on `,`/`;`) by their canonical key, keeping the first-seen display
 * casing and dropping empties. Order-preserving.
 */
export function dedupeTagNames(rawNames: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawNames) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const key = canonicalTagKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Splits a CSV "tags" cell (comma- or semicolon-separated) into de-duplicated names. */
export function parseTagList(raw: string): readonly string[] {
  return dedupeTagNames(raw.split(/[,;]/));
}

export interface ContactTagAssignment {
  readonly contactId: ContactId;
  readonly tagId: TagId;
}

export type TagFilterMode = "any" | "all";

export interface TagFilter {
  readonly tagIds: readonly TagId[];
  readonly mode: TagFilterMode;
}

/** No filter (empty `tagIds`) matches everything — the "show all contacts" default. */
export function contactMatchesTagFilter(
  contactTagIds: ReadonlySet<TagId> | readonly TagId[],
  filter: TagFilter,
): boolean {
  if (filter.tagIds.length === 0) return true;
  const set = contactTagIds instanceof Set ? contactTagIds : new Set(contactTagIds);
  return filter.mode === "all"
    ? filter.tagIds.every((id) => set.has(id))
    : filter.tagIds.some((id) => set.has(id));
}

/**
 * Filters a map of contactId -> assigned tag ids down to the ids matching
 * `filter`, preserving map iteration order. Pure — the caller is
 * responsible for having built `assignments` from a single, already
 * tenant-scoped query.
 */
export function filterContactIdsByTags<K>(
  assignments: ReadonlyMap<K, ReadonlySet<TagId> | readonly TagId[]>,
  filter: TagFilter,
): readonly K[] {
  const out: K[] = [];
  for (const [contactId, tagIds] of assignments) {
    if (contactMatchesTagFilter(tagIds, filter)) out.push(contactId);
  }
  return out;
}
