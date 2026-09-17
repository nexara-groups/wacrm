/**
 * meta-onboarding — application-layer repository/provider ports.
 *
 * Interfaces only: no SQL, no vendor SDK, no `core/database` import. Mirrors
 * `modules/organizations/application/ports.ts` and
 * `modules/platform-admin/application/ports.ts`. Persistence is implemented
 * in `infrastructure/onboarding-repository.ts`; the Meta Graph API is
 * implemented in `infrastructure/meta-business-provider.ts`.
 *
 * Table mapping (see `db/migrations/*/0010_meta_onboarding.sql`):
 *  onboarding_sessions         -> OnboardingSessionRepositoryPort
 *  meta_business_connections   -> MetaConnectionRepositoryPort
 *  onboarding_events           -> OnboardingEventRepositoryPort
 *
 * `SecretStorePort` is a NAMED SEAM, not a full secrets-management
 * implementation — see its own docstring below. It exists so this module
 * can state, at the type level, "a raw Meta access token is handed to this
 * port and nothing else" without owning (or building, per this module's
 * scope) the vault/KMS that ultimately backs it.
 */
import type { TenantContext } from "@nexara/core/context";
import type { OnboardingState } from "../domain/onboarding-state-machine";

// ---------------------------------------------------------------------------
// onboarding_sessions
// ---------------------------------------------------------------------------

export interface OnboardingSessionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly state: OnboardingState;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly lastError: string | null;
  readonly resumeToken: string;
}

export interface NewOnboardingSessionInput {
  readonly id: string;
  readonly state: OnboardingState;
  readonly startedAt: string;
  readonly resumeToken: string;
}

/**
 * Patches the mutable fields of a session row after a state-machine
 * transition (see `application/onboarding-service.ts`). `state` is always
 * supplied — even a `RECORD_FAILURE` self-loop re-supplies the unchanged
 * state, so every call site is explicit about what it is persisting rather
 * than relying on the repository to infer "no state change" from an absent
 * field.
 */
export interface OnboardingSessionStatePatch {
  readonly state: OnboardingState;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly lastError: string | null;
}

export interface OnboardingSessionRepositoryPort {
  create(tenant: TenantContext, input: NewOnboardingSessionInput): Promise<OnboardingSessionRecord>;

  /** The account's current (most recently started) session, if any. One
   *  logical "in-flight or most recent" session per account — an account
   *  that starts over after `complete` gets a new row, not a mutated old
   *  one, so `onboarding_events` keeps a clean history per attempt. */
  findCurrentForAccount(tenant: TenantContext): Promise<OnboardingSessionRecord | null>;

  findById(tenant: TenantContext, sessionId: string): Promise<OnboardingSessionRecord | null>;

  /** Resume-link lookup. MUST still filter by `tenant.tenantId` (the
   *  account) — a resume token is only ever meaningful within the account
   *  that issued it. */
  findByResumeToken(tenant: TenantContext, resumeToken: string): Promise<OnboardingSessionRecord | null>;

  updateState(tenant: TenantContext, sessionId: string, patch: OnboardingSessionStatePatch): Promise<OnboardingSessionRecord>;
}

// ---------------------------------------------------------------------------
// meta_business_connections
// ---------------------------------------------------------------------------

export interface MetaBusinessConnectionRecord {
  readonly accountId: string;
  readonly wabaId: string;
  readonly businessId: string;
  readonly phoneNumberId: string;
  /**
   * A REFERENCE to a secret (see `SecretStorePort` below), never the raw
   * access token. The repository implementation must never be handed
   * anything else here — enforced at the call site in
   * `application/onboarding-service.ts` (token exchange output is resolved
   * to a ref via `SecretStorePort.putSecret` BEFORE this port is ever
   * called) and asserted by this module's repository tests.
   */
  readonly accessTokenRef: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertMetaConnectionInput {
  readonly wabaId: string;
  readonly businessId: string;
  readonly phoneNumberId: string;
  readonly accessTokenRef: string;
  readonly updatedAt: string;
}

export interface MetaConnectionRepositoryPort {
  upsert(tenant: TenantContext, input: UpsertMetaConnectionInput): Promise<MetaBusinessConnectionRecord>;
  findByAccount(tenant: TenantContext): Promise<MetaBusinessConnectionRecord | null>;
}

// ---------------------------------------------------------------------------
// onboarding_events — append-only audit of every state transition
// ---------------------------------------------------------------------------

export interface OnboardingEventRecord {
  readonly id: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly eventType: string;
  readonly fromState: OnboardingState | null;
  readonly toState: OnboardingState;
  readonly detail: string | null;
  readonly occurredAt: string;
}

export interface NewOnboardingEventInput {
  readonly id: string;
  readonly sessionId: string;
  readonly eventType: string;
  readonly fromState: OnboardingState | null;
  readonly toState: OnboardingState;
  readonly detail: string | null;
  readonly occurredAt: string;
}

/**
 * Append-only by construction, same discipline as
 * `modules/platform-admin/domain/audit.ts`'s `PlatformAuditLogPort`: the
 * only write member is `append`, returning `void` — there is nothing to
 * chain into a later "edit this event" call. This is what makes the table
 * usable as evidence "for supporting a stuck customer" (build brief item 7):
 * a support agent must be able to trust that history was never rewritten.
 */
export interface OnboardingEventRepositoryPort {
  append(tenant: TenantContext, entry: NewOnboardingEventInput): Promise<void>;
  listForSession(tenant: TenantContext, sessionId: string): Promise<readonly OnboardingEventRecord[]>;
}

// ---------------------------------------------------------------------------
// Secret storage seam — access_token_ref, never a raw token in this DB
// ---------------------------------------------------------------------------

/**
 * `SecretStorePort` — the seam between "a raw Meta access token just came
 * back from `MetaBusinessProvider.exchangeCodeForToken`" and "a reference to
 * it is safe to write to `meta_business_connections.access_token_ref`".
 *
 * This module does NOT implement a vault/KMS-backed provider for this port
 * — that is a secrets-management concern outside `meta-onboarding`'s scope
 * (see build brief: "Work ONLY inside modules/meta-onboarding"). What this
 * module DOES guarantee, and what its tests assert, is that
 * `application/onboarding-service.ts` calls `putSecret` on every raw token
 * it receives and only ever passes the returned `ref` — never the raw
 * value — to `MetaConnectionRepositoryPort` or any log/event record. A real
 * implementation (Cloudflare Secrets, AWS Secrets Manager, HashiCorp Vault,
 * ...) can be wired in later without this module's domain/application code
 * changing at all.
 */
export interface SecretStorePort {
  /** Stores `rawValue` out-of-band and returns an opaque reference safe to
   *  persist. The reference carries no information about the secret's
   *  content. */
  putSecret(tenant: TenantContext, kind: "meta_access_token", rawValue: string): Promise<string>;

  /** Resolves a previously issued reference back to the raw secret, for
   *  making an authenticated Meta API call. Implementations must never log
   *  the resolved value. */
  resolveSecret(tenant: TenantContext, ref: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Re-exported so a caller can depend on one module for the whole port set.
// ---------------------------------------------------------------------------

export interface MetaOnboardingPorts {
  readonly sessions: OnboardingSessionRepositoryPort;
  readonly connections: MetaConnectionRepositoryPort;
  readonly events: OnboardingEventRepositoryPort;
  readonly secrets: SecretStorePort;
}
