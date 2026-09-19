/**
 * The standard success/error response envelope every endpoint contract in
 * this package returns. There is exactly one error shape across the whole
 * package: `errorEnvelopeSchema` (error-envelope.ts) — this helper is what
 * makes that mechanical rather than a convention someone can forget.
 */
import { z } from "zod";
import { errorEnvelopeSchema } from "./error-envelope";

/**
 * Wraps a success-payload shape into `{ ok: true, ...shape } | { ok: false,
 * error: ErrorEnvelope }`. `shape` is a `ZodRawShape` (an object literal of
 * field schemas, as passed to `z.object(...)`) rather than a pre-built
 * `ZodObject`, so a single-field success payload reads as
 * `apiResult({ contact: contactSchema })` and a payload with no extra data
 * beyond the `ok` flag reads as `apiResult({})`.
 */
export function apiResult<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), ...shape }),
    z.object({ ok: z.literal(false), error: errorEnvelopeSchema }),
  ]);
}
