/**
 * Per-account custom field definitions and typed values.
 *
 * Pure domain module: defines the field types, a stable-key generator, and
 * a typed validator/coercer for raw input (e.g. a CSV cell, which always
 * arrives as a string). No I/O — persistence lives in
 * `infrastructure/contact-repository.ts` via the `ContactRepository` port.
 */
import { err, ok, type Result } from "@shared/result";
import { AppError } from "@shared/errors";
import type { Brand } from "../../../packages/domain/src/brand";
import type { AccountId, ContactId } from "../../../packages/domain/src/ids";
import type { ISODateString } from "../../../packages/domain/src/entities/common";

export type CustomFieldId = Brand<string, "CustomFieldId">;

export type CustomFieldType = "text" | "number" | "boolean" | "date" | "select";

export const CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = [
  "text",
  "number",
  "boolean",
  "date",
  "select",
];

export interface CustomFieldDefinition {
  readonly id: CustomFieldId;
  readonly accountId: AccountId;
  /** Stable, machine-comparable key — see `slugifyFieldKey`. Unique per account. */
  readonly key: string;
  /** Human-readable label shown in the UI; may be edited without changing `key`. */
  readonly label: string;
  readonly type: CustomFieldType;
  /** Only meaningful (and required to be non-empty) when `type === "select"`. */
  readonly options: readonly string[] | null;
  readonly createdAt: ISODateString;
}

export type CustomFieldValue =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "date"; readonly value: string }
  | { readonly type: "select"; readonly value: string };

export interface ContactCustomFieldValue {
  readonly contactId: ContactId;
  readonly fieldId: CustomFieldId;
  readonly value: CustomFieldValue;
}

const KEY_UNSAFE_RE = /[^a-z0-9_]+/g;

/**
 * Derives a stable machine key from a human label: lowercase, non
 * alphanumerics collapsed to `_`, leading/trailing `_` trimmed. Used both
 * for operator-created fields (typed a label, we derive the key) and for
 * CSV import (a header cell becomes both the lookup key and, on first
 * sight, the label).
 */
export function slugifyFieldKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(KEY_UNSAFE_RE, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Type-checks and coerces a raw value (typically a CSV cell — always a
 * string, or a JSON-ish value from an API body) against `definition.type`.
 * Never throws; an invalid value is a `Result` error with a layman message
 * (META_ERROR_TAXONOMY.md §4b: no jargon, say what happened).
 */
export function validateCustomFieldValue(
  definition: Pick<CustomFieldDefinition, "type" | "label" | "options">,
  raw: unknown,
): Result<CustomFieldValue> {
  const asString = typeof raw === "string" ? raw.trim() : raw;

  switch (definition.type) {
    case "text": {
      if (typeof raw === "string") return ok({ type: "text", value: raw });
      if (raw === null || raw === undefined) return ok({ type: "text", value: "" });
      return ok({ type: "text", value: String(raw) });
    }
    case "number": {
      if (typeof raw === "number") {
        return Number.isFinite(raw)
          ? ok({ type: "number", value: raw })
          : err(AppError.validation(`"${definition.label}" needs a number — that value isn't finite.`));
      }
      const text = typeof raw === "string" ? raw.trim() : String(raw ?? "");
      if (text.length === 0) {
        return err(AppError.validation(`"${definition.label}" needs a number, but nothing was given.`));
      }
      const num = Number(text);
      if (!Number.isFinite(num)) {
        return err(AppError.validation(`"${definition.label}" needs a number — "${text}" isn't one.`));
      }
      return ok({ type: "number", value: num });
    }
    case "boolean": {
      if (typeof raw === "boolean") return ok({ type: "boolean", value: raw });
      const normalized = typeof asString === "string" ? asString.toLowerCase() : "";
      if (["true", "1", "yes", "y"].includes(normalized)) return ok({ type: "boolean", value: true });
      if (["false", "0", "no", "n", ""].includes(normalized)) return ok({ type: "boolean", value: false });
      return err(
        AppError.validation(`"${definition.label}" needs a yes/no value — "${String(raw)}" isn't one.`),
      );
    }
    case "date": {
      const text = typeof asString === "string" ? asString : String(asString ?? "");
      if (text.length === 0 || Number.isNaN(Date.parse(text))) {
        return err(AppError.validation(`"${definition.label}" needs a date — "${text}" doesn't look like one.`));
      }
      return ok({ type: "date", value: new Date(text).toISOString() });
    }
    case "select": {
      const text = typeof asString === "string" ? asString : String(asString ?? "");
      const options = definition.options ?? [];
      if (!options.includes(text)) {
        return err(
          AppError.validation(
            `"${text}" isn't one of the allowed values for "${definition.label}" (${options.join(", ")}).`,
          ),
        );
      }
      return ok({ type: "select", value: text });
    }
    default: {
      const exhaustive: never = definition.type;
      return err(AppError.validation(`Unknown custom field type: ${String(exhaustive)}`));
    }
  }
}

/**
 * Applies `updates` on top of `existing`, replacing any value whose
 * `fieldId` matches and appending new ones — a pure merge with no notion of
 * persistence. Used by import (and profile edits) to compute the full
 * post-update value set before handing it to the repository.
 */
export function mergeCustomFieldValues(
  existing: readonly ContactCustomFieldValue[],
  updates: readonly ContactCustomFieldValue[],
): readonly ContactCustomFieldValue[] {
  const byField = new Map<CustomFieldId, ContactCustomFieldValue>();
  for (const value of existing) byField.set(value.fieldId, value);
  for (const value of updates) byField.set(value.fieldId, value);
  return Array.from(byField.values());
}
