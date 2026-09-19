/**
 * Closed string-union vocabulary mirrored from `@packages/domain`.
 *
 * WHY THIS FILE RE-DECLARES LITERAL STRINGS INSTEAD OF IMPORTING THEM:
 * domain's `status/*.ts` modules each export both a `type X = "a" | "b"` and
 * a companion `readonly X[]` runtime array (e.g. `BROADCAST_STATUSES`). zod
 * needs concrete literal values at runtime to build `z.enum(...)`, so in
 * principle those arrays could be imported directly (they are individually
 * dependency-free). This package deliberately does NOT import them anyway:
 * the contract with every consumer (web/mobile/server) is "no runtime
 * dependency other than zod", and a value-level import from
 * `@packages/domain` — even of a currently-dependency-free file — puts a
 * live source edge across that boundary. The moment any of those domain
 * modules gains a real dependency, or a caller only has the barrel
 * (`packages/domain/src/index.ts`, which DOES pull in `@shared/errors`) to
 * import from, this package would inherit it silently.
 *
 * So the literal tuples below are hand-copied from
 * `packages/domain/src/status/*.ts` and `packages/domain/src/entities/*.ts`,
 * and kept in sync ONLY by the compile-time equality assertions in
 * `vocab-parity.test.ts`, which `import type`-only the real domain types and
 * assert structural equality. That is real, hand-maintained coupling that
 * the type system does not enforce automatically the way it does for the
 * branded id/value-object types in `./ids.ts` (those are reused exactly via
 * `import type` + `.transform()`, so they cannot silently drift). This is
 * the sharpest "module ports vs. this package" friction point found while
 * building this package — see this package's SubagentHandback report.
 */
import { z } from "zod";

/** Mirrors `packages/domain/src/status/broadcast-status.ts`. */
export const broadcastStatusSchema = z.enum(["draft", "scheduled", "sending", "sent", "failed"]);
export type BroadcastStatus = z.infer<typeof broadcastStatusSchema>;

/** Mirrors `packages/domain/src/status/recipient-status.ts`. */
export const recipientStatusSchema = z.enum([
  "pending",
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
]);
export type RecipientStatus = z.infer<typeof recipientStatusSchema>;

/** Mirrors `packages/domain/src/status/disposition.ts` — META_ERROR_TAXONOMY.md §2. */
export const dispositionSchema = z.enum([
  "TRANSIENT",
  "THROTTLED",
  "PERMANENT_NUMBER",
  "PERMANENT_CONFIG",
]);
export type Disposition = z.infer<typeof dispositionSchema>;

/** Mirrors `packages/domain/src/status/deliverability-state.ts` — META_ERROR_TAXONOMY.md §4. */
export const deliverabilityStateSchema = z.enum(["unknown", "reachable", "suppressed", "manually_cleared"]);
export type DeliverabilityState = z.infer<typeof deliverabilityStateSchema>;

/** Mirrors `packages/domain/src/status/consent-state.ts` — META_ERROR_TAXONOMY.md §3b. */
export const consentStateSchema = z.enum(["unknown", "opted_in", "opted_out", "do_not_contact"]);
export type ConsentState = z.infer<typeof consentStateSchema>;

/** Mirrors `packages/domain/src/entities/contact.ts`'s `OptOutSource`. */
export const optOutSourceSchema = z.enum(["keyword", "quick_reply", "inferred_block", "operator", "import"]);
export type OptOutSource = z.infer<typeof optOutSourceSchema>;

/** Mirrors `packages/domain/src/entities/contact.ts`'s `OptOutScope` — only "all" exists today (category scoping is provisioned, not built). */
export const optOutScopeSchema = z.literal("all");
export type OptOutScope = z.infer<typeof optOutScopeSchema>;

/** Mirrors `packages/domain/src/entities/message.ts`'s `MessageDirection`. */
export const messageDirectionSchema = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof messageDirectionSchema>;

/** Mirrors `packages/domain/src/entities/message.ts`'s `MessageType`. */
export const messageTypeSchema = z.enum(["text", "template", "media", "interactive", "system"]);
export type MessageType = z.infer<typeof messageTypeSchema>;

/** Mirrors `packages/domain/src/entities/template.ts`'s `TemplateCategory`. */
export const templateCategorySchema = z.enum(["marketing", "utility", "authentication"]);
export type TemplateCategory = z.infer<typeof templateCategorySchema>;

/** Mirrors `packages/domain/src/entities/template.ts`'s `TemplateApprovalStatus`. */
export const templateApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "paused", "disabled"]);
export type TemplateApprovalStatus = z.infer<typeof templateApprovalStatusSchema>;

/** Mirrors `packages/domain/src/phone-number.ts`'s `CountryCode`. */
export const countryCodeSchema = z.enum(["IN", "US", "CA", "GB", "AE", "AU", "SG"]);
export type CountryCode = z.infer<typeof countryCodeSchema>;

/**
 * Tenant member/invitation role vocabulary.
 *
 * SEAT_LIMITS.md §1 flags an UNRESOLVED conflict: the original app's schema
 * uses `owner`/`admin`/`agent`/`viewer` (`account_role_enum`), but the
 * framework (`nexara/core/rbac/roles.ts`, already consumed by the
 * already-built `modules/organizations` port) uses
 * `owner`/`admin`/`manager`/`member`. The spec says explicitly: "decide
 * during the organizations port; do not carry both vocabularies." That port
 * has already been built and chose the framework's four roles
 * (`modules/organizations/application/ports.ts` types every method against
 * `Role` from `@nexara/core/rbac`) — so this package follows that same
 * choice for consistency with the module it will eventually be wired to,
 * rather than reintroducing the old `agent`/`viewer` vocabulary. This is
 * still a hand-copied duplicate for the same "zod needs runtime literals,
 * `@nexara/core` is a framework import this package may not take" reason as
 * the rest of this file — see `vocab-parity.test.ts`.
 */
export const roleSchema = z.enum(["owner", "admin", "manager", "member"]);
export type Role = z.infer<typeof roleSchema>;

/** SEAT_LIMITS.md §1 `account_invitations`: `CHECK (role <> 'owner')` — an invitation may never grant ownership. */
export const invitableRoleSchema = roleSchema.exclude(["owner"]);
export type InvitableRole = z.infer<typeof invitableRoleSchema>;
