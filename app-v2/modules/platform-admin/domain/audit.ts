import type { PlatformRole } from "@nexara/core/rbac";
import type { TenantId, UserId } from "@shared/types";

/**
 * Platform audit log — append-only.
 *
 * Per `docs/rebuild discussion/phase-0/SUPER_ADMIN_CONSOLE.md` §5/§6:
 * "Audit log append-only and immutable — not writable by any platform role."
 * Every cross-tenant read is itself an auditable act (§4).
 *
 * This is modelled as append-only structurally, not by convention:
 *   - `PlatformAuditEntry` fields are all `readonly` — there is no setter.
 *   - `PlatformAuditLogPort` below exposes only `append` and read methods.
 *     There is no `update`/`delete`/`remove`/`amend` member on the interface
 *     — nothing to call even if an implementation wanted to mutate a row.
 *   - `PlatformAuditLogPort` is the only place a `PlatformAuditEntry` is
 *     accepted by an infrastructure boundary in this module; it never
 *     receives an entry `id` back for a later "patch" call because no such
 *     call exists.
 */
export interface PlatformAuditEntry {
  readonly id: string;
  readonly actor: UserId;
  readonly platformRole: PlatformRole;
  readonly action: string;
  readonly targetAccountId: TenantId | null;
  readonly targetResource: string | null;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** ISO-8601 timestamp. */
  readonly occurredAt: string;
  readonly requestId: string;
}

export interface CreateAuditEntryInput {
  readonly id: string;
  readonly actor: UserId;
  readonly platformRole: PlatformRole;
  readonly action: string;
  readonly targetAccountId?: TenantId | null;
  readonly targetResource?: string | null;
  readonly reason?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId: string;
  /** Injectable for tests; defaults to `new Date()`. */
  readonly occurredAt?: Date;
}

/** Build an audit entry. This is the only way to produce one — there is no mutation path afterward. */
export function createAuditEntry(input: CreateAuditEntryInput): PlatformAuditEntry {
  return {
    id: input.id,
    actor: input.actor,
    platformRole: input.platformRole,
    action: input.action,
    targetAccountId: input.targetAccountId ?? null,
    targetResource: input.targetResource ?? null,
    reason: input.reason ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    requestId: input.requestId,
  };
}

/**
 * Repository port for the audit log. Append-only by construction: the only
 * write member is `append`, which returns `void` (not the stored entry, so
 * there is nothing to chain into a follow-up "edit this" call). Reading is
 * itself an auditable act (§4), so read methods still require an explicit
 * verified platform principal — see `application/ports.ts`, which composes
 * this port alongside the module's other cross-tenant ports.
 */
/** Narrowing for an audit-log read. Every field is optional; omitting all of
 *  them reads the whole fleet's trail, which is legitimate here (§4) and is
 *  why the read is bounded by `limit` rather than by tenant. */
export interface PlatformAuditFilter {
  readonly targetAccountId?: string;
  readonly actor?: UserId;
  /** ISO-8601; entries at or after this instant. */
  readonly since?: string;
}

export interface PlatformAuditLogPort {
  /** Append one entry. No update/delete/replace member exists on this interface. */
  append(entry: PlatformAuditEntry): Promise<void>;

  /**
   * Read the trail, newest first, bounded.
   *
   * The port previously exposed only `append`, so the console could write
   * the audit log but never show it — which makes an audit log decorative.
   * The implementation had read methods; they just weren't reachable
   * through the interface the application layer depends on.
   *
   * `limit` is required, not defaulted. This table only ever grows, and an
   * unbounded read of it is a slow-motion outage on the one screen an
   * incident response needs to work.
   */
  list(filter: PlatformAuditFilter, limit: number): Promise<readonly PlatformAuditEntry[]>;
}
