/**
 * A boolean carried in a query string.
 *
 * NOT `z.coerce.boolean()`. Zod's coercion is `Boolean(value)`, and every
 * non-empty string is truthy — so `?unreadOnly=false` parses as `true`. A
 * coerced-boolean query field can therefore express "true" and "absent",
 * but never "false", and the one value it gets wrong is the one that reads
 * as though it were right. The api-client worked around this downstream by
 * refusing to serialise `false` at all; that kept callers safe but left the
 * filter one-way for anyone calling the endpoint directly.
 *
 * Accepting the two literal strings instead makes `false` expressible and
 * makes anything else a validation error rather than a silent `true`.
 */
import { z } from "zod";

export const booleanQueryFlagSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => (typeof value === "boolean" ? value : value === "true"));

export type BooleanQueryFlag = z.infer<typeof booleanQueryFlagSchema>;
