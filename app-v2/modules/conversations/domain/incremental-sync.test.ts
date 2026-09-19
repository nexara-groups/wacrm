import { describe, expect, it } from "vitest";
import {
  INITIAL_SYNC_CURSOR,
  advanceSyncCursor,
  compareSequence,
  decodeSyncCursor,
  encodeSyncCursor,
  isAfterCursor,
  syncPage,
  type SyncCursor,
  type Syncable,
} from "./incremental-sync";

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-01T00:00:01.000Z";

describe("isAfterCursor", () => {
  it("includes a row strictly after the cursor timestamp", () => {
    expect(isAfterCursor({ id: "a", updatedAt: T2 }, { updatedAt: T1, seenIds: [] })).toBe(true);
  });

  it("excludes a row strictly before the cursor timestamp", () => {
    expect(isAfterCursor({ id: "a", updatedAt: T1 }, { updatedAt: T2, seenIds: [] })).toBe(false);
  });

  it("includes a same-timestamp row not yet in seenIds", () => {
    expect(isAfterCursor({ id: "b", updatedAt: T1 }, { updatedAt: T1, seenIds: ["a"] })).toBe(true);
  });

  it("excludes a same-timestamp row already in seenIds", () => {
    expect(isAfterCursor({ id: "a", updatedAt: T1 }, { updatedAt: T1, seenIds: ["a"] })).toBe(false);
  });
});

describe("advanceSyncCursor — the concurrent-write guarantee", () => {
  it("does not skip a same-timestamp sibling that committed after the cursor already advanced", () => {
    // Writer A and writer B both write at T1, concurrently. The poll runs
    // after A commits but before B does, so the first page only contains A.
    const rowA: Syncable = { id: "row-a", updatedAt: T1 };
    let cursor = advanceSyncCursor(INITIAL_SYNC_CURSOR, [rowA]);
    expect(cursor).toEqual({ updatedAt: T1, seenIds: ["row-a"] });

    // B's write becomes visible only now. A naive `updated_at > cursor`
    // cursor would already exclude it forever (T1 is not > T1). The
    // keyset+seenIds cursor must still surface it.
    const rowB: Syncable = { id: "row-b", updatedAt: T1 };
    expect(isAfterCursor(rowB, cursor)).toBe(true);

    cursor = advanceSyncCursor(cursor, [rowB]);
    expect(cursor.updatedAt).toBe(T1);
    expect(new Set(cursor.seenIds)).toEqual(new Set(["row-a", "row-b"]));

    // Nothing is left pending — both were eventually delivered.
    expect(isAfterCursor(rowA, cursor)).toBe(false);
    expect(isAfterCursor(rowB, cursor)).toBe(false);
  });

  it("resets seenIds once the page's max timestamp moves forward", () => {
    let cursor = advanceSyncCursor(INITIAL_SYNC_CURSOR, [{ id: "a", updatedAt: T1 }]);
    cursor = advanceSyncCursor(cursor, [{ id: "z", updatedAt: T2 }]);
    expect(cursor).toEqual({ updatedAt: T2, seenIds: ["z"] });
  });

  it("is a no-op on an empty page", () => {
    const cursor: SyncCursor = { updatedAt: T1, seenIds: ["a"] };
    expect(advanceSyncCursor(cursor, [])).toBe(cursor);
  });

  it("never skips any row across many out-of-commit-order concurrent pages at the same instant", () => {
    // Simulate 5 rows all sharing one timestamp, delivered to the poller in
    // scrambled order across several small pages (as page-size limits or
    // commit-visibility races would produce in practice).
    const rows: Syncable[] = ["e", "b", "d", "a", "c"].map((id) => ({ id, updatedAt: T1 }));
    let cursor = INITIAL_SYNC_CURSOR;
    const delivered = new Set<string>();
    for (const row of rows) {
      // Only pages a row through once (mirrors `isAfterCursor` used as the
      // repository's WHERE clause) — a row already delivered must not
      // reappear, and nothing may be skipped by the time all pages are drained.
      if (isAfterCursor(row, cursor)) {
        delivered.add(row.id);
        cursor = advanceSyncCursor(cursor, [row]);
      }
    }
    expect(delivered).toEqual(new Set(["a", "b", "c", "d", "e"]));
    for (const row of rows) expect(isAfterCursor(row, cursor)).toBe(false);
  });
});

describe("syncPage", () => {
  it("returns only rows after the cursor, respecting the limit, in a stable order", () => {
    const rows: Syncable[] = [
      { id: "a", updatedAt: T1 },
      { id: "b", updatedAt: T1 },
      { id: "c", updatedAt: T2 },
    ];
    const first = syncPage(rows, INITIAL_SYNC_CURSOR, 2);
    expect(first.items.map((r) => r.id)).toEqual(["a", "b"]);

    const second = syncPage(rows, first.nextCursor, 2);
    expect(second.items.map((r) => r.id)).toEqual(["c"]);

    const third = syncPage(rows, second.nextCursor, 2);
    expect(third.items).toEqual([]);
  });
});

describe("cursor encode/decode round trip", () => {
  it("round-trips a cursor", () => {
    const cursor: SyncCursor = { updatedAt: T2, seenIds: ["a", "b"] };
    expect(decodeSyncCursor(encodeSyncCursor(cursor))).toEqual(cursor);
  });

  it("falls back to INITIAL_SYNC_CURSOR for garbage input", () => {
    expect(decodeSyncCursor("not-a-real-cursor!!")).toEqual(INITIAL_SYNC_CURSOR);
    expect(decodeSyncCursor(null)).toEqual(INITIAL_SYNC_CURSOR);
    expect(decodeSyncCursor(undefined)).toEqual(INITIAL_SYNC_CURSOR);
  });
});

describe("compareSequence", () => {
  it("orders by timestamp first, then id", () => {
    expect(compareSequence({ at: T1, id: "a" }, { at: T2, id: "a" })).toBeLessThan(0);
    expect(compareSequence({ at: T1, id: "b" }, { at: T1, id: "a" })).toBeGreaterThan(0);
    expect(compareSequence({ at: T1, id: "a" }, { at: T1, id: "a" })).toBe(0);
  });
});
