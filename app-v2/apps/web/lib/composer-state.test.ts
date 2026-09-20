import { describe, expect, it } from "vitest";
import type { Template } from "@packages/contracts/src/templates";
import {
  canSend,
  canSendInteractive,
  canSendMedia,
  emptyInteractiveState,
  emptyMediaState,
  INTERACTIVE_BODY_MAX_LENGTH,
  INTERACTIVE_BUTTON_TITLE_MAX_LENGTH,
  INTERACTIVE_LIST_BUTTON_LABEL_MAX_LENGTH,
  INTERACTIVE_LIST_ROW_DESCRIPTION_MAX_LENGTH,
  INTERACTIVE_LIST_ROW_TITLE_MAX_LENGTH,
  INTERACTIVE_LIST_SECTION_TITLE_MAX_LENGTH,
  INTERACTIVE_MAX_BUTTONS,
  INTERACTIVE_MAX_LIST_ROWS,
  initialComposerState,
  MEDIA_CAPTION_MAX_LENGTH,
  MEDIA_FILE_NAME_MAX_LENGTH,
  mediaKindOf,
  mediaNeedsUpload,
  previewTemplateBody,
  sendErrorMessage,
  TEXT_BODY_MAX_LENGTH,
  templateSlots,
  toInteractiveSendPayload,
  toMediaSendPayload,
  type ComposerState,
  type InteractiveState,
  type MediaState,
} from "./composer-state";

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: "tpl_1" as Template["id"],
    accountId: "acct_1" as Template["accountId"],
    name: "order_update",
    language: "en_US",
    category: "utility",
    status: "approved",
    bodyText: "Hi {{1}}, your order {{2}} has shipped.",
    variableCount: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function textState(overrides: Partial<ComposerState> = {}): ComposerState {
  return { ...initialComposerState(), mode: "text", ...overrides };
}

function templateState(overrides: Partial<ComposerState> = {}): ComposerState {
  return { ...initialComposerState(), mode: "template", ...overrides };
}

function mediaState(overrides: Partial<MediaState> = {}): MediaState {
  return { ...emptyMediaState(), ...overrides };
}

function interactiveState(overrides: Partial<InteractiveState> = {}): InteractiveState {
  return { ...emptyInteractiveState(), ...overrides };
}

describe("templateSlots", () => {
  it("returns one 1-based slot per variableCount", () => {
    expect(templateSlots(makeTemplate({ variableCount: 3 }))).toEqual([1, 2, 3]);
  });

  it("returns no slots for a template with no placeholders", () => {
    expect(templateSlots(makeTemplate({ variableCount: 0 }))).toEqual([]);
  });
});

describe("canSend — text mode", () => {
  it("is false for an empty body", () => {
    expect(canSend(textState({ text: "" }))).toBe(false);
  });

  it("is false for a whitespace-only body", () => {
    expect(canSend(textState({ text: "   \n\t " }))).toBe(false);
  });

  it("is true for a non-empty body within the 4096 limit", () => {
    expect(canSend(textState({ text: "Hello there" }))).toBe(true);
  });

  it("is false once the body exceeds the contract's 4096 limit", () => {
    expect(canSend(textState({ text: "a".repeat(TEXT_BODY_MAX_LENGTH + 1) }))).toBe(false);
  });

  it("is true right at the 4096 limit", () => {
    expect(canSend(textState({ text: "a".repeat(TEXT_BODY_MAX_LENGTH) }))).toBe(true);
  });
});

describe("canSend — template mode", () => {
  it("is false with no template selected", () => {
    expect(canSend(templateState({ selectedTemplate: null, parameters: [] }))).toBe(false);
  });

  it("is false when a slot is missing", () => {
    const template = makeTemplate({ variableCount: 2 });
    expect(canSend(templateState({ selectedTemplate: template, parameters: ["Aisha"] }))).toBe(false);
  });

  it("is false when a slot is filled with only whitespace", () => {
    const template = makeTemplate({ variableCount: 2 });
    expect(
      canSend(templateState({ selectedTemplate: template, parameters: ["Aisha", "   "] })),
    ).toBe(false);
  });

  it("is true when every slot is filled", () => {
    const template = makeTemplate({ variableCount: 2 });
    expect(
      canSend(templateState({ selectedTemplate: template, parameters: ["Aisha", "#1042"] })),
    ).toBe(true);
  });

  it("is true for a template with no parameters", () => {
    const template = makeTemplate({ variableCount: 0 });
    expect(canSend(templateState({ selectedTemplate: template, parameters: [] }))).toBe(true);
  });
});

describe("previewTemplateBody", () => {
  it("renders the template body with the given parameters", () => {
    const template = makeTemplate();
    expect(previewTemplateBody(template, ["Aisha", "#1042"])).toBe(
      "Hi Aisha, your order #1042 has shipped.",
    );
  });
});

describe("sendErrorMessage", () => {
  it("surfaces blocked_opted_out's laymanMessage", () => {
    const payload = {
      ok: false,
      error: {
        code: "blocked_opted_out",
        laymanMessage:
          "This person asked to stop receiving messages. You can't message them until they contact you again.",
      },
    };
    expect(sendErrorMessage(409, payload)).toBe(
      "This person asked to stop receiving messages. You can't message them until they contact you again.",
    );
  });

  it("surfaces blocked_do_not_contact's laymanMessage", () => {
    const payload = {
      ok: false,
      error: {
        code: "blocked_do_not_contact",
        laymanMessage: "This contact is marked do-not-contact and has been skipped.",
      },
    };
    expect(sendErrorMessage(409, payload)).toBe(
      "This contact is marked do-not-contact and has been skipped.",
    );
  });

  it("surfaces blocked_undeliverable's laymanMessage", () => {
    const payload = {
      ok: false,
      error: {
        code: "blocked_undeliverable",
        laymanMessage: "This number can't receive WhatsApp messages. We've stopped sending to it.",
      },
    };
    expect(sendErrorMessage(409, payload)).toBe(
      "This number can't receive WhatsApp messages. We've stopped sending to it.",
    );
  });

  it("surfaces template_not_approved's laymanMessage", () => {
    const payload = {
      ok: false,
      error: {
        code: "template_not_approved",
        laymanMessage: "This template hasn't been approved by Meta yet, so it can't be sent.",
      },
    };
    expect(sendErrorMessage(409, payload)).toBe(
      "This template hasn't been approved by Meta yet, so it can't be sent.",
    );
  });

  it("surfaces template_parameter_count's laymanMessage", () => {
    const payload = {
      ok: false,
      error: {
        code: "template_parameter_count",
        laymanMessage: "This template needs 2 parameter(s); 1 were given.",
      },
    };
    expect(sendErrorMessage(422, payload)).toBe("This template needs 2 parameter(s); 1 were given.");
  });

  it("surfaces provider_failure's laymanMessage", () => {
    const payload = {
      ok: false,
      error: {
        code: "provider_failure",
        laymanMessage: "WhatsApp couldn't deliver this message right now. Please try again.",
        operatorHint: "Meta: rate limited",
      },
    };
    expect(sendErrorMessage(502, payload)).toBe(
      "WhatsApp couldn't deliver this message right now. Please try again.",
    );
  });

  it("falls back to a readable message when the payload has no error envelope at all", () => {
    expect(sendErrorMessage(500, {})).not.toMatch(/undefined/);
    expect(sendErrorMessage(500, {})).toBe("The message couldn't be sent (500). Please try again.");
  });

  it("falls back to a readable message for a null/non-JSON payload", () => {
    expect(sendErrorMessage(0, null)).not.toMatch(/undefined/);
  });
});

describe("mediaKindOf", () => {
  it("is null before a file is picked (file source)", () => {
    expect(mediaKindOf(mediaState({ source: "file", hasFile: false }))).toBeNull();
  });

  it("reads the kind off the picked file's own MIME type", () => {
    expect(
      mediaKindOf(mediaState({ source: "file", hasFile: true, fileMimeType: "image/png" })),
    ).toBe("image");
  });

  it("is null for a picked file whose MIME type isn't in the allow-list — never a guess", () => {
    expect(
      mediaKindOf(mediaState({ source: "file", hasFile: true, fileMimeType: "application/zip" })),
    ).toBeNull();
  });

  it("uses the operator-picked kind on the URL path", () => {
    expect(mediaKindOf(mediaState({ source: "url", urlKind: "video" }))).toBe("video");
  });

  it("is null on the URL path before a kind is chosen", () => {
    expect(mediaKindOf(mediaState({ source: "url", urlKind: null }))).toBeNull();
  });
});

describe("canSend — media mode", () => {
  it("is false with no file picked (file source, the default)", () => {
    expect(canSend(textState({ mode: "media", media: mediaState() }))).toBe(false);
  });

  it("is true for a picked non-document file with no caption", () => {
    const media = mediaState({ source: "file", hasFile: true, fileMimeType: "image/jpeg" });
    expect(canSendMedia(media)).toBe(true);
  });

  it("is false for an unresolvable kind even with a file picked", () => {
    const media = mediaState({ source: "file", hasFile: true, fileMimeType: "application/zip" });
    expect(canSendMedia(media)).toBe(false);
  });

  it("is false for a document file with no file name", () => {
    const media = mediaState({ source: "file", hasFile: true, fileMimeType: "application/pdf", fileName: "" });
    expect(canSendMedia(media)).toBe(false);
  });

  it("is true for a document file once a file name is set", () => {
    const media = mediaState({
      source: "file",
      hasFile: true,
      fileMimeType: "application/pdf",
      fileName: "invoice.pdf",
    });
    expect(canSendMedia(media)).toBe(true);
  });

  it("is false once the file name exceeds the contract's 255 bound", () => {
    const media = mediaState({
      source: "file",
      hasFile: true,
      fileMimeType: "application/pdf",
      fileName: "a".repeat(MEDIA_FILE_NAME_MAX_LENGTH + 1),
    });
    expect(canSendMedia(media)).toBe(false);
  });

  it("is false once the caption exceeds the contract's 1024 bound", () => {
    const media = mediaState({
      source: "file",
      hasFile: true,
      fileMimeType: "image/jpeg",
      caption: "a".repeat(MEDIA_CAPTION_MAX_LENGTH + 1),
    });
    expect(canSendMedia(media)).toBe(false);
  });

  it("is true right at the caption's 1024 bound", () => {
    const media = mediaState({
      source: "file",
      hasFile: true,
      fileMimeType: "image/jpeg",
      caption: "a".repeat(MEDIA_CAPTION_MAX_LENGTH),
    });
    expect(canSendMedia(media)).toBe(true);
  });

  it("is false for the URL path with no URL entered", () => {
    const media = mediaState({ source: "url", urlKind: "image", mediaUrl: "" });
    expect(canSendMedia(media)).toBe(false);
  });

  it("is false for the URL path with an unparsable URL", () => {
    const media = mediaState({ source: "url", urlKind: "image", mediaUrl: "not a url" });
    expect(canSendMedia(media)).toBe(false);
  });

  it("is false for the URL path with no kind chosen", () => {
    const media = mediaState({ source: "url", urlKind: null, mediaUrl: "https://example.test/f.jpg" });
    expect(canSendMedia(media)).toBe(false);
  });

  it("is true for the URL path with a valid URL and kind", () => {
    const media = mediaState({ source: "url", urlKind: "image", mediaUrl: "https://example.test/f.jpg" });
    expect(canSendMedia(media)).toBe(true);
  });

  it("requires a file name for a document on the URL path too", () => {
    const media = mediaState({
      source: "url",
      urlKind: "document",
      mediaUrl: "https://example.test/f.pdf",
      fileName: "",
    });
    expect(canSendMedia(media)).toBe(false);
  });
});

describe("mediaNeedsUpload", () => {
  it("is true once a file is picked and no upload has completed yet", () => {
    expect(mediaNeedsUpload(mediaState({ source: "file", hasFile: true, uploadedMediaId: null }))).toBe(
      true,
    );
  });

  it("is false once an upload has completed", () => {
    expect(
      mediaNeedsUpload(mediaState({ source: "file", hasFile: true, uploadedMediaId: "media-abc" })),
    ).toBe(false);
  });

  it("is false on the URL path — nothing to upload", () => {
    expect(mediaNeedsUpload(mediaState({ source: "url", hasFile: false }))).toBe(false);
  });

  it("is false before any file is picked", () => {
    expect(mediaNeedsUpload(mediaState({ source: "file", hasFile: false }))).toBe(false);
  });
});

describe("toMediaSendPayload", () => {
  it("is null when the state can't send yet", () => {
    expect(toMediaSendPayload(emptyMediaState())).toBeNull();
  });

  it("is null for a picked file that hasn't finished uploading — never fabricates a mediaId", () => {
    const media = mediaState({
      source: "file",
      hasFile: true,
      fileMimeType: "image/jpeg",
      uploadedMediaId: null,
    });
    expect(toMediaSendPayload(media)).toBeNull();
  });

  it("builds the mediaId payload once upload has completed", () => {
    const media = mediaState({
      source: "file",
      hasFile: true,
      fileMimeType: "image/jpeg",
      uploadedMediaId: "media-abc",
      caption: "Look",
    });
    expect(toMediaSendPayload(media)).toEqual({
      mediaKind: "image",
      mediaId: "media-abc",
      caption: "Look",
      fileName: undefined,
    });
  });

  it("builds the mediaUrl payload for the URL path, with fileName for a document", () => {
    const media = mediaState({
      source: "url",
      urlKind: "document",
      mediaUrl: "https://example.test/f.pdf",
      fileName: "invoice.pdf",
    });
    expect(toMediaSendPayload(media)).toEqual({
      mediaKind: "document",
      mediaUrl: "https://example.test/f.pdf",
      caption: undefined,
      fileName: "invoice.pdf",
    });
  });

  it("omits an empty caption rather than sending a blank string", () => {
    const media = mediaState({
      source: "file",
      hasFile: true,
      fileMimeType: "image/jpeg",
      uploadedMediaId: "media-abc",
      caption: "",
    });
    expect(toMediaSendPayload(media)?.caption).toBeUndefined();
  });
});

describe("canSend — interactive mode", () => {
  it("is false with empty body text", () => {
    expect(canSendInteractive(interactiveState({ bodyText: "" }))).toBe(false);
  });

  it("is false once body text exceeds the contract's 1024 bound", () => {
    expect(
      canSendInteractive(interactiveState({ bodyText: "a".repeat(INTERACTIVE_BODY_MAX_LENGTH + 1) })),
    ).toBe(false);
  });

  it("is false for button mode with no buttons", () => {
    expect(canSendInteractive(interactiveState({ bodyText: "Pick one", kind: "button", buttons: [] }))).toBe(
      false,
    );
  });

  it("is true for button mode with 1-3 valid buttons", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "button",
      buttons: [{ id: "yes", title: "Yes" }, { id: "no", title: "No" }],
    });
    expect(canSendInteractive(state)).toBe(true);
  });

  it("is false for button mode past the 3-button max", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "button",
      buttons: Array.from({ length: INTERACTIVE_MAX_BUTTONS + 1 }, (_, i) => ({
        id: `b${i}`,
        title: `B${i}`,
      })),
    });
    expect(canSendInteractive(state)).toBe(false);
  });

  it("is false for a button title past the 20-char bound", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "button",
      buttons: [{ id: "yes", title: "a".repeat(INTERACTIVE_BUTTON_TITLE_MAX_LENGTH + 1) }],
    });
    expect(canSendInteractive(state)).toBe(false);
  });

  it("is true for a button title right at the 20-char bound", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "button",
      buttons: [{ id: "yes", title: "a".repeat(INTERACTIVE_BUTTON_TITLE_MAX_LENGTH) }],
    });
    expect(canSendInteractive(state)).toBe(true);
  });

  it("is false for a button with an empty id", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "button",
      buttons: [{ id: "", title: "Yes" }],
    });
    expect(canSendInteractive(state)).toBe(false);
  });

  it("is false for list mode with an empty button label", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "list",
      listButtonLabel: "",
      listSectionTitle: "Options",
      listRows: [{ id: "r1", title: "Row 1", description: "" }],
    });
    expect(canSendInteractive(state)).toBe(false);
  });

  it("is false for a list button label past the 20-char bound", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "list",
      listButtonLabel: "a".repeat(INTERACTIVE_LIST_BUTTON_LABEL_MAX_LENGTH + 1),
      listSectionTitle: "Options",
      listRows: [{ id: "r1", title: "Row 1", description: "" }],
    });
    expect(canSendInteractive(state)).toBe(false);
  });

  it("is false for list mode with an empty section title", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "list",
      listButtonLabel: "Choose",
      listSectionTitle: "",
      listRows: [{ id: "r1", title: "Row 1", description: "" }],
    });
    expect(canSendInteractive(state)).toBe(false);
  });

  it("is false for a section title past the 24-char bound", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "list",
      listButtonLabel: "Choose",
      listSectionTitle: "a".repeat(INTERACTIVE_LIST_SECTION_TITLE_MAX_LENGTH + 1),
      listRows: [{ id: "r1", title: "Row 1", description: "" }],
    });
    expect(canSendInteractive(state)).toBe(false);
  });

  it("is false for list mode with no rows", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "list",
      listButtonLabel: "Choose",
      listSectionTitle: "Options",
      listRows: [],
    });
    expect(canSendInteractive(state)).toBe(false);
  });

  it("is false for list mode past the 10-row max", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "list",
      listButtonLabel: "Choose",
      listSectionTitle: "Options",
      listRows: Array.from({ length: INTERACTIVE_MAX_LIST_ROWS + 1 }, (_, i) => ({
        id: `r${i}`,
        title: `Row ${i}`,
        description: "",
      })),
    });
    expect(canSendInteractive(state)).toBe(false);
  });

  it("is false for a row title past the 24-char bound", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "list",
      listButtonLabel: "Choose",
      listSectionTitle: "Options",
      listRows: [{ id: "r1", title: "a".repeat(INTERACTIVE_LIST_ROW_TITLE_MAX_LENGTH + 1), description: "" }],
    });
    expect(canSendInteractive(state)).toBe(false);
  });

  it("is false for a row description past the 72-char bound", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "list",
      listButtonLabel: "Choose",
      listSectionTitle: "Options",
      listRows: [
        { id: "r1", title: "Row 1", description: "a".repeat(INTERACTIVE_LIST_ROW_DESCRIPTION_MAX_LENGTH + 1) },
      ],
    });
    expect(canSendInteractive(state)).toBe(false);
  });

  it("is true for a valid list with an empty (omitted) row description", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "list",
      listButtonLabel: "Choose",
      listSectionTitle: "Options",
      listRows: [{ id: "r1", title: "Row 1", description: "" }],
    });
    expect(canSendInteractive(state)).toBe(true);
  });
});

describe("toInteractiveSendPayload", () => {
  it("is null when the state can't send yet", () => {
    expect(toInteractiveSendPayload(emptyInteractiveState())).toBeNull();
  });

  it("builds a button payload", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "button",
      buttons: [{ id: "yes", title: "Yes" }],
    });
    expect(toInteractiveSendPayload(state)).toEqual({
      bodyText: "Pick one",
      interactive: { kind: "button", buttons: [{ id: "yes", title: "Yes" }] },
    });
  });

  it("builds a single-section list payload, omitting an empty row description", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "list",
      listButtonLabel: "Choose",
      listSectionTitle: "Options",
      listRows: [{ id: "r1", title: "Row 1", description: "" }],
    });
    expect(toInteractiveSendPayload(state)).toEqual({
      bodyText: "Pick one",
      interactive: {
        kind: "list",
        buttonLabel: "Choose",
        sections: [{ title: "Options", rows: [{ id: "r1", title: "Row 1", description: undefined }] }],
      },
    });
  });

  it("keeps a non-empty row description", () => {
    const state = interactiveState({
      bodyText: "Pick one",
      kind: "list",
      listButtonLabel: "Choose",
      listSectionTitle: "Options",
      listRows: [{ id: "r1", title: "Row 1", description: "First option" }],
    });
    expect(toInteractiveSendPayload(state)?.interactive).toEqual({
      kind: "list",
      buttonLabel: "Choose",
      sections: [{ title: "Options", rows: [{ id: "r1", title: "Row 1", description: "First option" }] }],
    });
  });
});

describe("initialComposerState / emptyMediaState / emptyInteractiveState", () => {
  it("defaults to text mode with nothing entered", () => {
    const state = initialComposerState();
    expect(state.mode).toBe("text");
    expect(state.text).toBe("");
    expect(canSend(state)).toBe(false);
  });

  it("defaults media to the file source with nothing picked", () => {
    expect(emptyMediaState()).toMatchObject({ source: "file", hasFile: false, uploadedMediaId: null });
  });

  it("defaults interactive to button mode with no buttons", () => {
    expect(emptyInteractiveState()).toMatchObject({ kind: "button", buttons: [] });
  });
});
