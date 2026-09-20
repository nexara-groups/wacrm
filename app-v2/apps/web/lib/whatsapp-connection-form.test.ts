import { describe, expect, it } from "vitest";
import type { WhatsappRegistrationState } from "@packages/contracts/src/onboarding";
import {
  canSendMessages,
  isConnectionFormValid,
  REGISTRATION_STATE_LABEL,
  REGISTRATION_STATE_VARIANT,
  requiresReplaceConfirmation,
  selectSaveErrorMessage,
} from "./whatsapp-connection-form";

const ALL_STATES: readonly WhatsappRegistrationState[] = [
  "unregistered",
  "pending",
  "registered",
  "failed",
];

describe("registration state mapping", () => {
  it("has a distinct label and variant for every registration state", () => {
    for (const state of ALL_STATES) {
      expect(REGISTRATION_STATE_LABEL[state]).toBeTruthy();
      expect(REGISTRATION_STATE_VARIANT[state]).toBeTruthy();
    }
    const labels = new Set(ALL_STATES.map((state) => REGISTRATION_STATE_LABEL[state]));
    expect(labels.size).toBe(ALL_STATES.length);
  });

  it("only 'registered' can send", () => {
    expect(canSendMessages("registered")).toBe(true);
    for (const state of ALL_STATES) {
      if (state === "registered") continue;
      expect(canSendMessages(state)).toBe(false);
    }
  });

  it("gives 'registered' visibly different tone from the non-sending states", () => {
    expect(REGISTRATION_STATE_VARIANT.registered).not.toBe(REGISTRATION_STATE_VARIANT.unregistered);
    expect(REGISTRATION_STATE_VARIANT.registered).not.toBe(REGISTRATION_STATE_VARIANT.pending);
    expect(REGISTRATION_STATE_VARIANT.registered).not.toBe(REGISTRATION_STATE_VARIANT.failed);
  });
});

describe("isConnectionFormValid", () => {
  const valid = { wabaId: "waba-1", phoneNumberId: "phone-1", accessToken: "token-1" };

  it("requires all three fields", () => {
    expect(isConnectionFormValid(valid)).toBe(true);
    expect(isConnectionFormValid({ ...valid, wabaId: "" })).toBe(false);
    expect(isConnectionFormValid({ ...valid, phoneNumberId: "" })).toBe(false);
    expect(isConnectionFormValid({ ...valid, accessToken: "" })).toBe(false);
  });

  it("rejects whitespace-only values", () => {
    expect(isConnectionFormValid({ ...valid, wabaId: "   " })).toBe(false);
    expect(isConnectionFormValid({ ...valid, phoneNumberId: "\t" })).toBe(false);
    expect(isConnectionFormValid({ ...valid, accessToken: "  \n " })).toBe(false);
  });
});

describe("requiresReplaceConfirmation", () => {
  it("only warns when a connection already exists", () => {
    expect(requiresReplaceConfirmation(true)).toBe(true);
    expect(requiresReplaceConfirmation(false)).toBe(false);
  });
});

describe("selectSaveErrorMessage", () => {
  it("renders the server's laymanMessage and operatorHint when present, regardless of status", () => {
    const body = { ok: false as const, error: { laymanMessage: "Only owners can do that.", operatorHint: "Ask an owner." } };
    expect(selectSaveErrorMessage(403, body)).toEqual({
      message: "Only owners can do that.",
      hint: "Ask an owner.",
    });
    expect(selectSaveErrorMessage(409, { ok: false, error: { laymanMessage: "Number mismatch." } })).toEqual({
      message: "Number mismatch.",
      hint: undefined,
    });
  });

  it("falls back to an honest generic message when there's no parseable envelope", () => {
    expect(selectSaveErrorMessage(500, null).message).toBe("Couldn't save the connection. Try again.");
  });

  it("still names the permission gate for an unparseable 403", () => {
    expect(selectSaveErrorMessage(403, null).message).toMatch(/owner/i);
  });
});
