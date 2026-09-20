import { describe, expect, it } from "vitest";
import type { Template } from "@packages/contracts/src/templates";
import {
  canSend,
  previewTemplateBody,
  sendErrorMessage,
  TEXT_BODY_MAX_LENGTH,
  templateSlots,
  type ComposerState,
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
  return { mode: "text", text: "", selectedTemplate: null, parameters: [], ...overrides };
}

function templateState(overrides: Partial<ComposerState> = {}): ComposerState {
  return { mode: "template", text: "", selectedTemplate: null, parameters: [], ...overrides };
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
