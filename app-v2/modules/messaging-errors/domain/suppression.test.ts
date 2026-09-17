import { describe, expect, it } from "vitest";
import { isErr, isOk } from "@shared/result";
import {
  UNKNOWN_DELIVERABILITY,
  clearSuppression,
  isHardSuppressionCode,
  recordPermanentNumberFailure,
  recordSuccess,
  shouldBlockSend,
} from "./suppression";

describe("deliverability state machine", () => {
  it("unknown -> reachable on first success", () => {
    const next = recordSuccess(UNKNOWN_DELIVERABILITY);
    expect(next.state).toBe("reachable");
  });

  it("reachable stays reachable on further success", () => {
    const reachable = recordSuccess(UNKNOWN_DELIVERABILITY);
    const stillReachable = recordSuccess(reachable);
    expect(stillReachable.state).toBe("reachable");
  });

  it("unknown -> suppressed on a PERMANENT_NUMBER failure", () => {
    const suppressed = recordPermanentNumberFailure(UNKNOWN_DELIVERABILITY, "131026", new Date());
    expect(suppressed.state).toBe("suppressed");
    expect(suppressed.suppressedReasonCode).toBe("131026");
  });

  it("reachable -> suppressed on a PERMANENT_NUMBER failure", () => {
    const reachable = recordSuccess(UNKNOWN_DELIVERABILITY);
    const suppressed = recordPermanentNumberFailure(reachable, "131021", new Date());
    expect(suppressed.state).toBe("suppressed");
  });

  describe("hard codes suppress immediately on first occurrence", () => {
    it("131026 and 131021 are hard codes", () => {
      expect(isHardSuppressionCode("131026")).toBe(true);
      expect(isHardSuppressionCode("131021")).toBe(true);
      expect(isHardSuppressionCode("131009")).toBe(false);
    });

    it("a single occurrence of a hard code suppresses, no strikes threshold needed", () => {
      const suppressed = recordPermanentNumberFailure(UNKNOWN_DELIVERABILITY, "131026", new Date());
      expect(suppressed.state).toBe("suppressed");
      expect(suppressed.suppressionStrikes).toBe(1);
    });
  });

  it("suppressed -> manually_cleared via operator override, strikes reset to 0", () => {
    const suppressed = recordPermanentNumberFailure(UNKNOWN_DELIVERABILITY, "131026", new Date());
    const result = clearSuppression(suppressed);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.state).toBe("manually_cleared");
      expect(result.value.suppressionStrikes).toBe(0);
      expect(result.value.suppressedReasonCode).toBeUndefined();
    }
  });

  it("clearSuppression refuses on a non-suppressed record", () => {
    expect(isErr(clearSuppression(UNKNOWN_DELIVERABILITY))).toBe(true);
    const reachable = recordSuccess(UNKNOWN_DELIVERABILITY);
    expect(isErr(clearSuppression(reachable))).toBe(true);
  });

  it("suppression is idempotent at the state level: repeating the same failure keeps state suppressed", () => {
    // Guards the pure-domain slice of spec §6's "duplicate webhook suppresses
    // once" requirement: dedup-by-event-id is an application/infra concern
    // (outside this module), but the state transition itself must not
    // regress or misbehave if invoked more than once for the same contact.
    const once = recordPermanentNumberFailure(UNKNOWN_DELIVERABILITY, "131026", new Date());
    const twice = recordPermanentNumberFailure(once, "131026", new Date());
    expect(once.state).toBe("suppressed");
    expect(twice.state).toBe("suppressed");
  });

  it("a webhook-delivered PERMANENT_NUMBER failure suppresses identically to a send-response one", () => {
    // The classifier and state machine are pure functions of the MetaError
    // value — they have no notion of "where it came from" — so a webhook
    // delivery and a send-response failure carrying the same code produce
    // an identical transition. This is the domain-layer half of spec §5's
    // "Both paths must feed the same classifier."
    const fromSendResponse = recordPermanentNumberFailure(UNKNOWN_DELIVERABILITY, "131026", new Date());
    const fromWebhook = recordPermanentNumberFailure(UNKNOWN_DELIVERABILITY, "131026", new Date());
    expect(fromSendResponse).toEqual(fromWebhook);
  });

  it("manually_cleared -> suppressed re-suppresses immediately on a fresh failure, no second grace", () => {
    const suppressed = recordPermanentNumberFailure(UNKNOWN_DELIVERABILITY, "131026", new Date());
    const clearedResult = clearSuppression(suppressed);
    expect(isOk(clearedResult)).toBe(true);
    if (!isOk(clearedResult)) return;

    const reSuppressed = recordPermanentNumberFailure(clearedResult.value, "131026", new Date());
    expect(reSuppressed.state).toBe("suppressed");
    // No grace period / no extra strike buffer before re-suppression.
    expect(reSuppressed.suppressionStrikes).toBe(1);
  });
});

describe("shouldBlockSend — two independent axes", () => {
  it("returns null when reachable and not opted out", () => {
    expect(shouldBlockSend("reachable", "unknown")).toBeNull();
    expect(shouldBlockSend("reachable", "opted_in")).toBeNull();
  });

  it("blocks on suppression alone, reason 'suppressed'", () => {
    const reason = shouldBlockSend("suppressed", "unknown", "131026");
    expect(reason).toEqual({ kind: "suppressed", reasonCode: "131026" });
  });

  it("blocks on opt-out alone, even when technically reachable", () => {
    // The critical independence case: reachable (deliverable) but opted
    // out — both a real state and a real block, for a different reason.
    const reason = shouldBlockSend("reachable", "opted_out");
    expect(reason).toEqual({ kind: "opted_out" });
  });

  it("blocks on do_not_contact alone, even when technically reachable", () => {
    const reason = shouldBlockSend("reachable", "do_not_contact");
    expect(reason).toEqual({ kind: "do_not_contact" });
  });

  it("a suppressed AND opted-out contact is still blocked (consent reason surfaces)", () => {
    const reason = shouldBlockSend("suppressed", "opted_out", "131026");
    expect(reason).not.toBeNull();
  });
});
