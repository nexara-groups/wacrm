/**
 * Cursor-based incremental sync — the V1 realtime replacement per
 * ARCHITECTURE_MODEL.md §6 ("Realtime V1 = foreground polling + push +
 * incremental sync behind a RealtimeProvider; WebSocket/DO only if UX/scale
 * proves it needed") and SUPABASE_EXIT_PLAN.md §1/§2 (replacing the 6
 * `postgres_changes` channels — message thread, inbox, presence,
 * total-unread, notifications page, notification count — with a client that
 * polls "what changed since my last cursor?").
 *
 * The hard requirement: **no change may be skipped by a cursor advance**,
 * even when two rows are written with the same `updated_at` millisecond by
 * concurrent writers (a very real case here — a webhook ingest worker and an
 * operator's UI action can both touch a conversation/message at once).
 *
 * A naive cursor (`WHERE updated_at > cursor`, next cursor = max(updated_at)
 * of the page) has a race: if writer A commits at T and the poll runs before
 * writer B's concurrent write (also at T) commits, the poll returns only A's
 * row, advances the cursor to T, and B's row — sharing that exact timestamp —
 * is now `updated_at = T`, which fails `> T` forever. It is silently
 * skipped.
 *
 * The fix used here is a **keyset cursor with a tie-break set**: the cursor
 * is `(updatedAt, seenIds)`, where `seenIds` holds every id already
 * delivered *at exactly* `updatedAt`. The query becomes
 * `updated_at > cursor.updatedAt OR (updated_at = cursor.updatedAt AND id
 * NOT IN seenIds)` — so a row sharing the boundary timestamp is only ever
 * excluded once it has actually been delivered, never because a sibling
 * write at the same timestamp happened to be seen first. This only breaks if
 * a write's `updated_at` is ever set to a value the cursor has already fully
 * passed (`< cursor.updatedAt`); every writer must use an application-
 * generated, non-decreasing timestamp for `updated_at` (see the migration
 * header), never a value it backdates.
 *
 * Pure — no I/O, no clock reads. Repositories translate `isAfterCursor` /
 * `SyncCursor` into the actual `WHERE` clause; this module owns only the
 * cursor algebra so it can be unit-tested without a database.
 */
import type { ISODateString } from "@packages/domain";

/** Anything that can be synced incrementally: an id plus a last-write timestamp. */
export interface Syncable {
  readonly id: string;
  readonly updatedAt: ISODateString;
}

/**
 * A sync cursor: "everything up to `updatedAt` has been delivered, plus
 * these specific ids that share that exact timestamp." `seenIds` is only
 * ever non-empty for the single instant named by `updatedAt` — it is not a
 * running dedupe set across the whole sync.
 */
export interface SyncCursor {
  readonly updatedAt: ISODateString;
  readonly seenIds: readonly string[];
}

/** The cursor a fresh client starts from — "I have seen nothing yet." */
export const INITIAL_SYNC_CURSOR: SyncCursor = { updatedAt: "1970-01-01T00:00:00.000Z", seenIds: [] };

/**
 * Pure predicate mirroring the repository's `WHERE` clause: true when `row`
 * has not yet been delivered under `cursor`. Exposed mainly so the exact
 * same rule can be unit-tested and used to filter an in-memory fake
 * repository the same way the real SQL does.
 */
export function isAfterCursor(row: Syncable, cursor: SyncCursor): boolean {
  if (row.updatedAt > cursor.updatedAt) return true;
  if (row.updatedAt < cursor.updatedAt) return false;
  return !cursor.seenIds.includes(row.id);
}

/**
 * Advances a cursor past one delivered page. Never skips a same-timestamp
 * sibling that simply was not in this page (e.g. it was still uncommitted
 * when the poll ran, or a page-size limit cut it off): if the page's maximum
 * `updatedAt` does not exceed the cursor's, `seenIds` accumulates rather
 * than resets, so the next poll (still filtering on the same `updatedAt`)
 * will pick it up. Only once a page's maximum timestamp strictly exceeds the
 * cursor's does `seenIds` reset — every row from before that boundary is, by
 * construction, no longer reachable by `isAfterCursor`, so nothing is lost
 * by no longer tracking those ids individually.
 *
 * An empty page never advances the cursor (nothing new happened).
 */
export function advanceSyncCursor(cursor: SyncCursor, page: readonly Syncable[]): SyncCursor {
  if (page.length === 0) return cursor;

  let maxUpdatedAt = cursor.updatedAt;
  for (const row of page) {
    if (row.updatedAt > maxUpdatedAt) maxUpdatedAt = row.updatedAt;
  }

  const idsAtMax = new Set(maxUpdatedAt === cursor.updatedAt ? cursor.seenIds : []);
  for (const row of page) {
    if (row.updatedAt === maxUpdatedAt) idsAtMax.add(row.id);
  }

  return { updatedAt: maxUpdatedAt, seenIds: [...idsAtMax] };
}

/**
 * Applies `isAfterCursor` + `advanceSyncCursor` together over a full known
 * data set — used by tests and by an in-memory fake repository. A real
 * repository instead pushes `isAfterCursor`'s predicate into SQL and calls
 * `advanceSyncCursor` on whatever page it fetched.
 */
export function syncPage<T extends Syncable>(
  rows: readonly T[],
  cursor: SyncCursor,
  limit: number,
): { readonly items: readonly T[]; readonly nextCursor: SyncCursor } {
  const pending = rows
    .filter((row) => isAfterCursor(row, cursor))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.id < b.id ? -1 : 1));
  const items = pending.slice(0, Math.max(0, limit));
  return { items, nextCursor: advanceSyncCursor(cursor, items) };
}

// `btoa`/`atob` (not `Buffer`) so this stays runtime-portable — Workers has
// no Node `Buffer` global, and the domain layer must not assume one. Cursor
// payloads are ISO-8601 timestamps and UUIDs, i.e. always ASCII, so the
// Latin1-only contract of `btoa`/`atob` is never in question here.
function toBase64Url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return atob(padded + padding);
}

/** Opaque cursor encoding for handing a cursor to a client across an HTTP boundary. */
export function encodeSyncCursor(cursor: SyncCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

/** Inverse of `encodeSyncCursor`. Falls back to `INITIAL_SYNC_CURSOR` for anything malformed
 * (a client showing up with a garbled/foreign cursor gets a full resync, never a crash). */
export function decodeSyncCursor(encoded: string | null | undefined): SyncCursor {
  if (!encoded) return INITIAL_SYNC_CURSOR;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(encoded));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "updatedAt" in parsed &&
      typeof (parsed as { updatedAt: unknown }).updatedAt === "string" &&
      "seenIds" in parsed &&
      Array.isArray((parsed as { seenIds: unknown }).seenIds)
    ) {
      const candidate = parsed as { updatedAt: string; seenIds: unknown[] };
      if (candidate.seenIds.every((id) => typeof id === "string")) {
        return { updatedAt: candidate.updatedAt, seenIds: candidate.seenIds as string[] };
      }
    }
  } catch {
    // fall through to INITIAL_SYNC_CURSOR
  }
  return INITIAL_SYNC_CURSOR;
}

/**
 * A simple `(at, id)` keyset — used by thread pagination (see
 * `application/inbox-service.ts`), which is a plain, non-tie-tracking
 * keyset: paging *backwards* through history by `created_at` never has the
 * "sibling not yet committed" race incremental sync must handle, because a
 * page boundary that has already been shown is never revisited going
 * forward in time. This makes it naturally stable under concurrent
 * insertion — new rows always sort after any cursor already handed out, so
 * they can never shift already-delivered pages.
 */
export interface SequenceCursor {
  readonly at: ISODateString;
  readonly id: string;
}

/** Total order over `(at, id)`, ascending. */
export function compareSequence(a: SequenceCursor, b: SequenceCursor): number {
  if (a.at < b.at) return -1;
  if (a.at > b.at) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
