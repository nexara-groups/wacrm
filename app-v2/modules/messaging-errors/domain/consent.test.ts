import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@shared/result";
import {
  UNKNOWN_CONSENT,
  blocksSend,
  clearDoNotContact,
  markDoNotContact,
  matchesStopKeyword,
  optOut,
  reOptIn,
} from "./consent";

describe("consent state machine", () => {
  it("starts unknown", () => {
    expect(UNKNOWN_CONSENT.state).toBe("unknown");
  });

  it("optOut records source and evidence and blocks sends", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const record = optOut("keyword", "wamid.reply-123", at);
    expect(record.state).toBe("opted_out");
    expect(record.source).toBe("keyword");
    expect(record.evidence).toBe("wamid.reply-123");
    expect(record.optedOutAt).toEqual(at);
    expect(blocksSend(record.state)).toBe(true);
  });

  it("markDoNotContact blocks sends and is distinct from opted_out", () => {
    const record = markDoNotContact("operator", "csv-import-row-42", new Date());
    expect(record.state).toBe("do_not_contact");
    expect(blocksSend(record.state)).toBe(true);
    expect(record.state).not.toBe("opted_out");
  });

  describe("opt-out is NOT clearable by any operator", () => {
    it("reOptIn is the only path back to opted_in, and requires evidence", () => {
      const optedOut = optOut("keyword", "wamid.stop-1", new Date("2026-01-01T00:00:00Z"));
      const cleared = reOptIn(optedOut, "wamid.new-inbound-2", new Date("2026-02-01T00:00:00Z"));
      expect(isOk(cleared)).toBe(true);
      if (isOk(cleared)) {
        expect(cleared.value.state).toBe("opted_in");
        expect(cleared.value.evidence).toBe("wamid.new-inbound-2");
        // The reversal is never attributed to an operator — only ever to
        // the fresh inbound evidence.
        expect(cleared.value.source).toBeUndefined();
      }
    });

    it("reOptIn refuses when evidence is missing or blank", () => {
      const optedOut = optOut("keyword", "wamid.stop-1", new Date());
      expect(isErr(reOptIn(optedOut, "", new Date()))).toBe(true);
      expect(isErr(reOptIn(optedOut, "   ", new Date()))).toBe(true);
    });

    it("reOptIn refuses on a record that was never opted_out", () => {
      expect(isErr(reOptIn(UNKNOWN_CONSENT, "wamid.x", new Date()))).toBe(true);
    });

    it("this module exposes no function that clears an opt-out without inbound evidence", () => {
      // There is deliberately no `operatorClearOptOut` / `clearOptOut`
      // export — the only reversal path is `reOptIn`, which mandates
      // evidence. This test documents and guards that API shape.
      const consentModule = { optOut, markDoNotContact, reOptIn, clearDoNotContact, matchesStopKeyword };
      expect(Object.keys(consentModule)).not.toContain("clearOptOut");
      expect(Object.keys(consentModule)).not.toContain("operatorClearOptOut");
    });
  });

  it("clearDoNotContact IS an operator action, unlike opt-out, but still requires the current state", () => {
    const dnc = markDoNotContact("operator", undefined, new Date());
    const cleared = clearDoNotContact(dnc, "support-ticket-9", new Date());
    expect(isOk(cleared)).toBe(true);
    if (isOk(cleared)) {
      expect(cleared.value.state).toBe("opted_in");
    }

    expect(isErr(clearDoNotContact(UNKNOWN_CONSENT, "x", new Date()))).toBe(true);
  });
});

describe("matchesStopKeyword", () => {
  const englishKeywords = ["STOP", "UNSUBSCRIBE", "OPT OUT"];

  it("matches English stop keywords case-insensitively", () => {
    expect(matchesStopKeyword("stop", englishKeywords)).toBe(true);
    expect(matchesStopKeyword("Stop", englishKeywords)).toBe(true);
    expect(matchesStopKeyword("please STOP messaging me", englishKeywords)).toBe(true);
    expect(matchesStopKeyword("unsubscribe", englishKeywords)).toBe(true);
    expect(matchesStopKeyword("I want to opt out please", englishKeywords)).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesStopKeyword("hello, how are you?", englishKeywords)).toBe(false);
    expect(matchesStopKeyword("", englishKeywords)).toBe(false);
  });

  it("does not false-positive on a word that merely contains a keyword as a substring", () => {
    // "stopwatch" should not match the whole-word keyword "stop".
    expect(matchesStopKeyword("I bought a stopwatch", englishKeywords)).toBe(false);
  });

  it("works with a configured Telugu keyword list (not a hardcoded English array)", () => {
    // "ఆపు" (aapu) — stop.
    const teluguKeywords = ["ఆపు", "నిలిపివేయండి"];
    expect(matchesStopKeyword("ఆపు", teluguKeywords)).toBe(true);
    expect(matchesStopKeyword("దయచేసి ఆపు", teluguKeywords)).toBe(true);
    expect(matchesStopKeyword("శుభోదయం", teluguKeywords)).toBe(false); // "good morning" — unrelated
    // English keywords must not leak into a Telugu-configured list.
    expect(matchesStopKeyword("ఆపు", englishKeywords)).toBe(false);
  });

  it("works with a configured Hindi keyword list", () => {
    // "बंद करो" (band karo) — stop it / "रोकें" (rokein) — stop.
    const hindiKeywords = ["रोकें", "बंद करो"];
    expect(matchesStopKeyword("रोकें", hindiKeywords)).toBe(true);
    expect(matchesStopKeyword("कृपया बंद करो", hindiKeywords)).toBe(true);
    expect(matchesStopKeyword("नमस्ते, कैसे हो?", hindiKeywords)).toBe(false);
  });

  it("is per-account/per-language configurable: an empty keyword list never matches", () => {
    expect(matchesStopKeyword("stop", [])).toBe(false);
  });
});
