/**
 * Branded identifier types for the WACRM core vocabulary, plus validating
 * constructors. All of these are UUID-shaped strings (matching the Postgres/
 * D1 schema, which uses `UUID` primary keys throughout — see SEAT_LIMITS.md
 * and META_ERROR_TAXONOMY.md's table sketches).
 *
 * Pure — no I/O, no DB. `@shared/errors` is a dependency-free type/class
 * module, not a vendor/runtime dependency, so importing it does not violate
 * the "zod only" rule for this package.
 */
import { AppError } from "@shared/errors";
import type { Brand } from "./brand";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Builds a validating constructor for a branded id type. The returned
 * function both IS the constructor and, via the `export type X = ReturnType`
 * pattern used below, the value/type pair follows the same
 * `export const Foo = ...; export type Foo = ...` idiom TypeScript uses for
 * classes — callers write `AccountId(raw)` to both validate and brand.
 */
function idConstructor<B extends string>(brandName: B) {
  return (value: string): Brand<string, B> => {
    if (typeof value !== "string") {
      throw AppError.validation(`${brandName} must be a string, got ${typeof value}`);
    }
    const trimmed = value.trim();
    if (!UUID_RE.test(trimmed)) {
      throw AppError.validation(`${brandName} must be a valid UUID, got: ${JSON.stringify(value)}`);
    }
    return trimmed as Brand<string, B>;
  };
}

/** True when `value` is a syntactically valid UUID, without brand/type narrowing side effects thrown. */
export function isValidId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export type AccountId = Brand<string, "AccountId">;
export const AccountId = idConstructor("AccountId");

export type UserId = Brand<string, "UserId">;
export const UserId = idConstructor("UserId");

export type ContactId = Brand<string, "ContactId">;
export const ContactId = idConstructor("ContactId");

export type ConversationId = Brand<string, "ConversationId">;
export const ConversationId = idConstructor("ConversationId");

export type MessageId = Brand<string, "MessageId">;
export const MessageId = idConstructor("MessageId");

export type BroadcastId = Brand<string, "BroadcastId">;
export const BroadcastId = idConstructor("BroadcastId");

export type TemplateId = Brand<string, "TemplateId">;
export const TemplateId = idConstructor("TemplateId");
