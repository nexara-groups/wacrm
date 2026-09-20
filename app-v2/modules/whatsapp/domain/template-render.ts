/**
 * Renders a template's stored `bodyText` with send-time parameters for the
 * COPY WE STORE in the message row — so the inbox thread shows readable
 * text instead of literal `{{1}}` placeholders. Meta does its own hydration
 * server-side from the same positional parameters; this is a local mirror
 * only, not what is sent over the wire.
 */

/**
 * Replaces `{{1}}`, `{{2}}`, ... positionally (1-based) with `parameters`.
 *
 * An index with no corresponding parameter (send-time array shorter than
 * the template expects) is left as the literal placeholder — never the
 * string "undefined", which would be a worse read than the placeholder it
 * replaced.
 *
 * Single pass: a parameter's own text can itself contain `{{2}}` (e.g. a
 * customer-supplied name), and that text must NOT be re-expanded. Using a
 * replacer function inside one `.replace()` call (rather than looping over
 * parameters and re-running `.replace()` per index) guarantees each match
 * in the ORIGINAL string is visited exactly once.
 */
export function renderTemplateBody(bodyText: string, parameters: readonly string[]): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (match, indexStr: string) => {
    const index = Number.parseInt(indexStr, 10) - 1;
    return index >= 0 && index < parameters.length ? parameters[index]! : match;
  });
}
