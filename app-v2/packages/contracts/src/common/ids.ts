/**
 * Branded id + value-object schemas that wrap `@packages/domain`'s
 * vocabulary for the request/response boundary.
 *
 * This package's only runtime dependency is zod (see package-level rule in
 * AGENTS.md / the contracts build brief) — `@packages/domain` itself has a
 * REAL runtime dependency (`@shared/errors`, thrown by `idConstructor` and
 * `parsePhoneNumber`), so a value-level import of domain would leak that
 * dependency into every web/mobile/server consumer of this package. Every
 * import from `@packages/domain` below is therefore `import type` only —
 * erased entirely at compile time (this repo's `isolatedModules` +
 * `verbatimModuleSyntax`-adjacent discipline requires writing it as `import
 * type` explicitly, not just relying on elision).
 *
 * The upshot: `contactIdSchema.parse(x)` returns the EXACT `ContactId`
 * branded type domain declares — not a structurally-similar lookalike — by
 * validating with the byte-for-byte same regex domain's `idConstructor`
 * uses, then `.transform()`-casting into the branded type. A payload that
 * parses here is therefore guaranteed to also construct successfully via
 * `packages/domain`'s own constructor; there is no second, looser notion of
 * "valid id" living in this package.
 */
import { z } from "zod";
import type {
  AccountId,
  BroadcastId,
  ContactId,
  ConversationId,
  MessageId,
  PhoneNumber,
  TemplateId,
  UserId,
} from "@packages/domain";

/** Verbatim copy of packages/domain/src/ids.ts's `UUID_RE`. Keep in sync by hand if that ever changes. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Verbatim copy of packages/domain/src/phone-number.ts's `E164_STRUCTURE_RE`. */
const E164_STRUCTURE_RE = /^\+[1-9]\d{7,14}$/;

export const accountIdSchema = z
  .string()
  .regex(UUID_RE, "Must be a valid UUID")
  .transform((value) => value as AccountId);

export const userIdSchema = z
  .string()
  .regex(UUID_RE, "Must be a valid UUID")
  .transform((value) => value as UserId);

export const contactIdSchema = z
  .string()
  .regex(UUID_RE, "Must be a valid UUID")
  .transform((value) => value as ContactId);

export const conversationIdSchema = z
  .string()
  .regex(UUID_RE, "Must be a valid UUID")
  .transform((value) => value as ConversationId);

export const messageIdSchema = z
  .string()
  .regex(UUID_RE, "Must be a valid UUID")
  .transform((value) => value as MessageId);

export const broadcastIdSchema = z
  .string()
  .regex(UUID_RE, "Must be a valid UUID")
  .transform((value) => value as BroadcastId);

export const templateIdSchema = z
  .string()
  .regex(UUID_RE, "Must be a valid UUID")
  .transform((value) => value as TemplateId);

/**
 * An already-normalised E.164 phone number, as stored/returned by the
 * server (mirrors domain's `PhoneNumber` brand exactly). NOT for request
 * bodies where a human is typing a number — use `rawPhoneNumberInputSchema`
 * for those, since normalisation (country-code resolution, trunk-prefix
 * stripping) is server-side logic this zod-only package cannot perform
 * without importing `parsePhoneNumber` (a real runtime dependency).
 */
export const phoneNumberSchema = z
  .string()
  .regex(E164_STRUCTURE_RE, "Must be an E.164 phone number")
  .transform((value) => value as PhoneNumber);

/**
 * Raw, not-yet-normalised phone number input (a create/import request field)
 * — anything a human might type ("9876543210", "+91 98765 43210",
 * "091-98765-43210"). Deliberately loose: normalisation and the real
 * validity check happen server-side via `parsePhoneNumber`, which needs the
 * account's default country and is not something this package may perform.
 * A request that fails this schema is malformed (empty/absurdly long); a
 * request that PASSES this schema can still be rejected server-side as "not
 * a valid phone number" — that is expected, not a contract violation.
 */
export const rawPhoneNumberInputSchema = z.string().trim().min(3).max(32);

/** An opaque, non-branded row id (e.g. `BroadcastRecipient.id` per domain's own comment: "not one of the branded id types"). */
export const opaqueIdSchema = z.string().min(1);

/**
 * ISO-8601 UTC timestamp string — mirrors domain's `ISODateString` (itself
 * "kept as a plain string — no Date at rest across a serialisation
 * boundary"). Validated, not branded: `ISODateString` is a plain `string`
 * alias in domain, not a nominal brand, so there is nothing to transform
 * into here.
 */
export const isoDateTimeSchema = z.iso.datetime();

export type {
  AccountId,
  BroadcastId,
  ContactId,
  ConversationId,
  MessageId,
  PhoneNumber,
  TemplateId,
  UserId,
};
