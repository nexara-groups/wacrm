/**
 * Pure decision logic for the inbox thread composer
 * (`components/inbox/composer.tsx`). Kept out of the `.tsx` entirely because
 * `vitest.config.ts` runs `environment: "node"` with no React test
 * infrastructure — every branch an operator can hit (what to render, when
 * the send button is enabled, what a failed send should say) has to be
 * expressible and testable as plain data in and data out.
 */
import type { Template } from "@packages/contracts/src/templates";
import { renderTemplateBody } from "@modules/whatsapp/domain/template-render";

/** The contract's own `sendTextMessageRequestSchema.body` bound (`z.string().min(1).max(4096)`). */
export const TEXT_BODY_MAX_LENGTH = 4096;

export type ComposerMode = "text" | "template";

export interface ComposerState {
  readonly mode: ComposerMode;
  readonly text: string;
  readonly selectedTemplate: Template | null;
  readonly parameters: readonly string[];
}

/**
 * One input slot per `{{n}}` placeholder in the template, derived from
 * `variableCount` rather than scanning `bodyText` again here — the count is
 * already server-derived and authoritative (see `templates.ts`'s header
 * comment), so a second regex pass over `bodyText` could only disagree with
 * it, never improve on it.
 */
export function templateSlots(template: Template): readonly number[] {
  return Array.from({ length: template.variableCount }, (_, i) => i + 1);
}

/**
 * Whether the send control should be enabled. An all-whitespace slot counts
 * as empty: Meta rejects a blank template parameter (132000-adjacent), and a
 * body of only spaces is not a message an operator meant to send.
 */
export function canSend(state: ComposerState): boolean {
  if (state.mode === "text") {
    const trimmedLength = state.text.trim().length;
    return trimmedLength > 0 && state.text.length <= TEXT_BODY_MAX_LENGTH;
  }

  const template = state.selectedTemplate;
  if (template === null) return false;
  if (state.parameters.length !== template.variableCount) return false;
  return state.parameters.every((p) => p.trim().length > 0);
}

/** The operator-facing preview of a template send — the same rendering the server records as the message body. */
export function previewTemplateBody(template: Template, parameters: readonly string[]): string {
  return renderTemplateBody(template.bodyText, parameters);
}

interface ErrorEnvelopeLike {
  readonly laymanMessage?: unknown;
}

interface ErrorPayloadLike {
  readonly error?: ErrorEnvelopeLike;
}

/**
 * The message shown inline when a send fails. Always prefers the API's
 * `laymanMessage` when the payload carries one — the 409 `blocked_*` cases
 * are the whole reason that field exists (an operator needs to know a
 * customer opted out, not read "something went wrong" and try again). Status
 * is accepted for a future finer-grained fallback but is not currently
 * branched on: every send-route failure already comes back with a
 * `laymanMessage` (`sendFailureResponse`, `validationError`, `notFoundError`,
 * `internalError` all set one), so the generic fallback below is reached
 * only by a malformed or non-JSON response, never a real route failure.
 */
export function sendErrorMessage(status: number, payload: unknown): string {
  const laymanMessage = (payload as ErrorPayloadLike | null | undefined)?.error?.laymanMessage;
  if (typeof laymanMessage === "string" && laymanMessage.length > 0) return laymanMessage;
  return `The message couldn't be sent (${status}). Please try again.`;
}
