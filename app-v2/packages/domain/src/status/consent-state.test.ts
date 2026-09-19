import { describe, expect, it } from "vitest";
import {
  canTransitionConsentState,
  consentBlocksSend,
  isSuppressedConsentState,
  type ConsentActor,
} from "./consent-state";

describe("ConsentState machine (META_ERROR_TAXONOMY.md §3b)", () => {
  it("unknown -> opted_out is legal for the contact (stop keyword/quick-reply/inferred block)", () => {
    expect(canTransitionConsentState("unknown", "opted_out", "contact")).toBe(true);
    expect(canTransitionConsentState("unknown", "opted_out", "inferred")).toBe(true);
  });

  it("unknown -> opted_out is illegal for an operator or import (an operator cannot fabricate a customer opt-out)", () => {
    expect(canTransitionConsentState("unknown", "opted_out", "operator")).toBe(false);
    expect(canTransitionConsentState("unknown", "opted_out", "import")).toBe(false);
  });

  it("unknown -> do_not_contact is legal for operator/import only", () => {
    expect(canTransitionConsentState("unknown", "do_not_contact", "operator")).toBe(true);
    expect(canTransitionConsentState("unknown", "do_not_contact", "import")).toBe(true);
    expect(canTransitionConsentState("unknown", "do_not_contact", "contact")).toBe(false);
  });

  describe("opted_out is NOT clearable by any operator (the load-bearing rule)", () => {
    it("opted_out -> opted_in is legal only when actor is the contact", () => {
      expect(canTransitionConsentState("opted_out", "opted_in", "contact")).toBe(true);
    });

    it("opted_out -> opted_in is illegal for operator, import, or inferred", () => {
      const actors: ConsentActor[] = ["operator", "import", "inferred"];
      for (const actor of actors) {
        expect(canTransitionConsentState("opted_out", "opted_in", actor)).toBe(false);
      }
    });
  });

  describe("do_not_contact IS clearable by an operator (the business's own flag, unlike opt-out)", () => {
    it("do_not_contact -> opted_in is legal for operator", () => {
      expect(canTransitionConsentState("do_not_contact", "opted_in", "operator")).toBe(true);
    });

    it("do_not_contact -> opted_in is illegal for contact, import, or inferred", () => {
      const actors: ConsentActor[] = ["contact", "import", "inferred"];
      for (const actor of actors) {
        expect(canTransitionConsentState("do_not_contact", "opted_in", actor)).toBe(false);
      }
    });
  });

  it("rejects a same-state transition regardless of actor", () => {
    expect(canTransitionConsentState("opted_out", "opted_out", "contact")).toBe(false);
    expect(canTransitionConsentState("unknown", "unknown", "operator")).toBe(false);
  });

  it("rejects an unreachable target entirely (opted_in -> unknown has no edge)", () => {
    expect(canTransitionConsentState("opted_in", "unknown", "contact")).toBe(false);
    expect(canTransitionConsentState("opted_in", "unknown", "operator")).toBe(false);
  });

  it("opted_in -> opted_out is legal for the contact", () => {
    expect(canTransitionConsentState("opted_in", "opted_out", "contact")).toBe(true);
  });

  it("opted_in -> do_not_contact is legal for operator/import", () => {
    expect(canTransitionConsentState("opted_in", "do_not_contact", "operator")).toBe(true);
  });

  it("isSuppressedConsentState / consentBlocksSend agree, and only for opted_out/do_not_contact", () => {
    expect(isSuppressedConsentState("opted_out")).toBe(true);
    expect(isSuppressedConsentState("do_not_contact")).toBe(true);
    expect(isSuppressedConsentState("opted_in")).toBe(false);
    expect(isSuppressedConsentState("unknown")).toBe(false);
    expect(consentBlocksSend("opted_out")).toBe(true);
    expect(consentBlocksSend("do_not_contact")).toBe(true);
    expect(consentBlocksSend("opted_in")).toBe(false);
  });
});
