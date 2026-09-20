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
// Type-only: the provider port's `MediaKind` (image/video/audio/document —
// no "sticker", see `@/lib/media-upload`'s header) is reused verbatim here
// rather than the contract's wider `mediaKindSchema` enum, so a composer
// that only ever holds one of these four values can never construct
// "sticker" in the first place — the send route's 422 for it becomes
// unreachable from the UI instead of merely handled.
import type { MediaKind } from "@modules/whatsapp/domain/whatsapp-provider.interface";
import { mimeTypeToMediaKind } from "./media-upload";

/** The contract's own `sendTextMessageRequestSchema.body` bound (`z.string().min(1).max(4096)`). */
export const TEXT_BODY_MAX_LENGTH = 4096;

export type ComposerMode = "text" | "template" | "media" | "interactive";

export interface ComposerState {
  readonly mode: ComposerMode;
  readonly text: string;
  readonly selectedTemplate: Template | null;
  readonly parameters: readonly string[];
  readonly media: MediaState;
  readonly interactive: InteractiveState;
}

/** A fresh composer, defaulted to text mode — what a newly-opened thread's composer, or a mode switch away from media/interactive, resets to. */
export function initialComposerState(): ComposerState {
  return {
    mode: "text",
    text: "",
    selectedTemplate: null,
    parameters: [],
    media: emptyMediaState(),
    interactive: emptyInteractiveState(),
  };
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
  switch (state.mode) {
    case "text": {
      const trimmedLength = state.text.trim().length;
      return trimmedLength > 0 && state.text.length <= TEXT_BODY_MAX_LENGTH;
    }
    case "template": {
      const template = state.selectedTemplate;
      if (template === null) return false;
      if (state.parameters.length !== template.variableCount) return false;
      return state.parameters.every((p) => p.trim().length > 0);
    }
    case "media":
      return canSendMedia(state.media);
    case "interactive":
      return canSendInteractive(state.interactive);
  }
}

/** The operator-facing preview of a template send — the same rendering the server records as the message body. */
export function previewTemplateBody(template: Template, parameters: readonly string[]): string {
  return renderTemplateBody(template.bodyText, parameters);
}

// ---------------------------------------------------------------------------
// Media mode
//
// Mirrors `sendMediaMessageRequestSchema` (`@packages/contracts/src/
// messages.ts`) exactly: exactly one of a local file or a URL, a `MediaKind`
// that is never operator-typed for a file (read off the file's own MIME
// type instead — see the `MediaKind` import above), a caption within the
// contract's bound, and a required file name for `document`.
// ---------------------------------------------------------------------------

export type MediaSource = "file" | "url";

/** The contract's `sendMediaMessageRequestSchema.caption` bound. */
export const MEDIA_CAPTION_MAX_LENGTH = 1024;
/** The contract's `sendMediaMessageRequestSchema.fileName` bound. */
export const MEDIA_FILE_NAME_MAX_LENGTH = 255;

export interface MediaState {
  readonly source: MediaSource;
  /** Whether a file has been picked. Only meaningful when `source === "file"`. */
  readonly hasFile: boolean;
  /**
   * The picked file's own `File.type` — never operator-set. Only meaningful
   * when `source === "file"`; `null` before a file is picked.
   */
  readonly fileMimeType: string | null;
  /**
   * Set once `POST /api/media` (`@/app/api/media/route.ts`) returns a
   * mediaId for the picked file, and kept from then on: a send that fails
   * AFTER a successful upload must retry only the send, never re-upload
   * the same bytes. `null` until that upload completes, and irrelevant for
   * `source === "url"`.
   */
  readonly uploadedMediaId: string | null;
  /** Only meaningful when `source === "url"` — sent to Meta as-is, which fetches it. */
  readonly mediaUrl: string;
  /**
   * Operator-picked kind for the URL path, where (unlike a picked file)
   * there is no MIME type to read a kind from. `null` until chosen, and
   * irrelevant for `source === "file"`. Typed as the same `MediaKind` as
   * the file path, so "sticker" is never a value this field can hold.
   */
  readonly urlKind: MediaKind | null;
  /** Prefilled from the picked file's name on the file path; free text, required for `document`, on the URL path. */
  readonly fileName: string;
  readonly caption: string;
}

export function emptyMediaState(): MediaState {
  return {
    source: "file",
    hasFile: false,
    fileMimeType: null,
    uploadedMediaId: null,
    mediaUrl: "",
    urlKind: null,
    fileName: "",
    caption: "",
  };
}

/**
 * The `MediaKind` this state currently resolves to, or `null` when it
 * cannot yet be determined (no file picked, or no URL kind chosen). Never a
 * guess: the file path reads the kind off the file's real MIME type via the
 * same allow-list `POST /api/media` enforces server-side, so a kind the
 * server would reject as `unsupported_media_type` resolves to `null` here
 * too, rather than a kind that only disagrees with the server later.
 */
export function mediaKindOf(media: MediaState): MediaKind | null {
  if (media.source === "file") {
    return media.hasFile ? mimeTypeToMediaKind(media.fileMimeType ?? "") : null;
  }
  return media.urlKind;
}

/** Same "is this a URL at all" bar `z.url()` enforces server-side — not a full re-implementation of it, just enough to keep an obviously-broken value from enabling Send. */
function isPlausibleMediaUrl(value: string): boolean {
  if (value.trim().length === 0) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the media send control should be enabled: exactly one of
 * file/url populated (the source itself is the toggle — the operator can
 * never fill both at once because only one input is ever rendered), a
 * resolvable kind, a filename for `document` (matches the media send
 * route's own `filename_required` 422), and a caption within bounds.
 */
export function canSendMedia(media: MediaState): boolean {
  const kind = mediaKindOf(media);
  if (kind === null) return false;

  if (media.source === "file") {
    if (!media.hasFile) return false;
  } else if (!isPlausibleMediaUrl(media.mediaUrl)) {
    return false;
  }

  if (kind === "document" && media.fileName.trim().length === 0) return false;
  if (media.fileName.length > MEDIA_FILE_NAME_MAX_LENGTH) return false;
  if (media.caption.length > MEDIA_CAPTION_MAX_LENGTH) return false;

  return true;
}

/**
 * True once the operator has picked a file that has not yet been uploaded
 * — the `.tsx` uses this to decide whether `handleSend` needs a
 * `POST /api/media` round trip before it can call the media send route at
 * all. Always `false` on the URL path, which needs no upload.
 */
export function mediaNeedsUpload(media: MediaState): boolean {
  return media.source === "file" && media.hasFile && media.uploadedMediaId === null;
}

/** The body `sendMediaMessageRequestSchema` expects, everything but `conversationId` (the route's own path param). */
export interface MediaSendPayload {
  readonly mediaKind: MediaKind;
  readonly mediaId?: string;
  readonly mediaUrl?: string;
  readonly caption?: string;
  readonly fileName?: string;
}

/**
 * Builds the send request body, or `null` when the state either can't send
 * yet (`canSendMedia` is false) or — file path only — has a picked file
 * whose upload hasn't completed (`mediaNeedsUpload`): there is no
 * `mediaId` to send yet, and this never fabricates one.
 */
export function toMediaSendPayload(media: MediaState): MediaSendPayload | null {
  if (!canSendMedia(media)) return null;
  const kind = mediaKindOf(media);
  if (kind === null) return null;

  const caption = media.caption.trim().length > 0 ? media.caption : undefined;
  const fileName = kind === "document" ? media.fileName : undefined;

  if (media.source === "file") {
    if (media.uploadedMediaId === null) return null;
    return { mediaKind: kind, mediaId: media.uploadedMediaId, caption, fileName };
  }
  return { mediaKind: kind, mediaUrl: media.mediaUrl, caption, fileName };
}

// ---------------------------------------------------------------------------
// Interactive mode
//
// Mirrors `interactivePayloadSchema` (`@packages/contracts/src/
// messages.ts`) exactly, including every length bound — a client that lets
// an operator type past one of these just turns into a 422 they can't
// explain. Exposes a single list section: `interactiveListSectionSchema`
// supports several, but this is a UI limitation, not a contract one — see
// `InteractiveState.listSectionTitle`/`listRows` below.
// ---------------------------------------------------------------------------

export type InteractiveKind = "button" | "list";

/** Matches `interactiveButtonSchema`. */
export interface InteractiveButtonInput {
  readonly id: string;
  readonly title: string;
}

/** Matches `interactiveListRowSchema`; `description` empty means "omit it" (it is optional on the wire). */
export interface InteractiveListRowInput {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export const INTERACTIVE_BODY_MAX_LENGTH = 1024;
export const INTERACTIVE_MAX_BUTTONS = 3;
export const INTERACTIVE_BUTTON_ID_MAX_LENGTH = 256;
export const INTERACTIVE_BUTTON_TITLE_MAX_LENGTH = 20;
export const INTERACTIVE_LIST_BUTTON_LABEL_MAX_LENGTH = 20;
/** `interactiveListSectionSchema.title` — the one section this UI exposes still needs one. */
export const INTERACTIVE_LIST_SECTION_TITLE_MAX_LENGTH = 24;
export const INTERACTIVE_MAX_LIST_ROWS = 10;
export const INTERACTIVE_LIST_ROW_ID_MAX_LENGTH = 200;
export const INTERACTIVE_LIST_ROW_TITLE_MAX_LENGTH = 24;
export const INTERACTIVE_LIST_ROW_DESCRIPTION_MAX_LENGTH = 72;

export interface InteractiveState {
  readonly bodyText: string;
  readonly kind: InteractiveKind;
  readonly buttons: readonly InteractiveButtonInput[];
  readonly listButtonLabel: string;
  /** The single exposed section's title — see this block's header comment. */
  readonly listSectionTitle: string;
  readonly listRows: readonly InteractiveListRowInput[];
}

export function emptyInteractiveState(): InteractiveState {
  return {
    bodyText: "",
    kind: "button",
    buttons: [],
    listButtonLabel: "",
    listSectionTitle: "",
    listRows: [],
  };
}

function isValidInteractiveButton(button: InteractiveButtonInput): boolean {
  return (
    button.id.trim().length > 0 &&
    button.id.length <= INTERACTIVE_BUTTON_ID_MAX_LENGTH &&
    button.title.trim().length > 0 &&
    button.title.length <= INTERACTIVE_BUTTON_TITLE_MAX_LENGTH
  );
}

function isValidInteractiveListRow(row: InteractiveListRowInput): boolean {
  if (row.id.trim().length === 0 || row.id.length > INTERACTIVE_LIST_ROW_ID_MAX_LENGTH) return false;
  if (row.title.trim().length === 0 || row.title.length > INTERACTIVE_LIST_ROW_TITLE_MAX_LENGTH) return false;
  if (row.description.length > INTERACTIVE_LIST_ROW_DESCRIPTION_MAX_LENGTH) return false;
  return true;
}

/**
 * Whether the interactive send control should be enabled: non-empty body
 * text within bound, and — per `interactivePayloadSchema`'s discriminated
 * union — either 1-3 valid buttons or a valid list (label, one section
 * title, 1-10 valid rows), every field within the contract's own limits.
 */
export function canSendInteractive(state: InteractiveState): boolean {
  if (state.bodyText.trim().length === 0 || state.bodyText.length > INTERACTIVE_BODY_MAX_LENGTH) {
    return false;
  }

  if (state.kind === "button") {
    return (
      state.buttons.length > 0 &&
      state.buttons.length <= INTERACTIVE_MAX_BUTTONS &&
      state.buttons.every(isValidInteractiveButton)
    );
  }

  if (
    state.listButtonLabel.trim().length === 0 ||
    state.listButtonLabel.length > INTERACTIVE_LIST_BUTTON_LABEL_MAX_LENGTH
  ) {
    return false;
  }
  if (
    state.listSectionTitle.trim().length === 0 ||
    state.listSectionTitle.length > INTERACTIVE_LIST_SECTION_TITLE_MAX_LENGTH
  ) {
    return false;
  }
  return (
    state.listRows.length > 0 &&
    state.listRows.length <= INTERACTIVE_MAX_LIST_ROWS &&
    state.listRows.every(isValidInteractiveListRow)
  );
}

/** The body `sendInteractiveMessageRequestSchema` expects, everything but `conversationId`. */
export interface InteractiveSendPayload {
  readonly bodyText: string;
  readonly interactive:
    | { readonly kind: "button"; readonly buttons: readonly InteractiveButtonInput[] }
    | {
        readonly kind: "list";
        readonly buttonLabel: string;
        // A single-entry array — see this block's header comment on why
        // only one section is exposed.
        readonly sections: readonly [
          { readonly title: string; readonly rows: readonly { readonly id: string; readonly title: string; readonly description?: string }[] },
        ];
      };
}

export function toInteractiveSendPayload(state: InteractiveState): InteractiveSendPayload | null {
  if (!canSendInteractive(state)) return null;

  if (state.kind === "button") {
    return { bodyText: state.bodyText, interactive: { kind: "button", buttons: state.buttons } };
  }

  return {
    bodyText: state.bodyText,
    interactive: {
      kind: "list",
      buttonLabel: state.listButtonLabel,
      sections: [
        {
          title: state.listSectionTitle,
          rows: state.listRows.map((row) => ({
            id: row.id,
            title: row.title,
            description: row.description.trim().length > 0 ? row.description : undefined,
          })),
        },
      ],
    },
  };
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
