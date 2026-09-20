import { describe, expect, it } from "vitest";
import {
  canTransitionDeliverabilityState,
  nextDeliverabilityState,
  type DeliverabilityState,
  type DeliverabilityTrigger,
} from "./deliverability-state";

describe("DeliverabilityState machine (META_ERROR_TAXONOMY.md §4)", () => {
  it("unknown -> reachable on first success", () => {
    expect(canTransitionDeliverabilityState("unknown", "reachable", "send_success")).toBe(true);
    expect(nextDeliverabilityState("unknown", "send_success")).toBe("reachable");
  });

  it("unknown -> suppressed on PERMANENT_NUMBER", () => {
    expect(canTransitionDeliverabilityState("unknown", "suppressed", "permanent_number_error")).toBe(true);
  });

  it("reachable -> suppressed on PERMANENT_NUMBER", () => {
    expect(canTransitionDeliverabilityState("reachable", "suppressed", "permanent_number_error")).toBe(true);
  });

  it("suppressed -> manually_cleared on operator override", () => {
    expect(canTransitionDeliverabilityState("suppressed", "manually_cleared", "operator_override")).toBe(true);
  });

  it("manually_cleared -> suppressed on PERMANENT_NUMBER, immediately (no second grace)", () => {
    expect(canTransitionDeliverabilityState("manually_cleared", "suppressed", "permanent_number_error")).toBe(true);
  });

  it("rejects reachable -> manually_cleared (no such edge)", () => {
    expect(canTransitionDeliverabilityState("reachable", "manually_cleared", "operator_override")).toBe(false);
  });

  it("rejects operator override from anywhere except suppressed", () => {
    const states: DeliverabilityState[] = ["unknown", "reachable", "manually_cleared"];
    for (const from of states) {
      expect(canTransitionDeliverabilityState(from, "manually_cleared", "operator_override")).toBe(false);
    }
  });

  it("a success does not un-suppress a suppressed or manually_cleared number", () => {
    expect(canTransitionDeliverabilityState("suppressed", "reachable", "send_success")).toBe(false);
    expect(canTransitionDeliverabilityState("manually_cleared", "reachable", "send_success")).toBe(false);
  });

  it("reachable stays put on repeat success (no self-transition modelled as legal)", () => {
    expect(canTransitionDeliverabilityState("reachable", "reachable", "send_success")).toBe(false);
  });

  it("nextDeliverabilityState returns undefined for a trigger with no effect from that state", () => {
    expect(nextDeliverabilityState("suppressed", "send_success")).toBeUndefined();
  });

  it("every legal edge round-trips through nextDeliverabilityState", () => {
    const cases: Array<[DeliverabilityState, DeliverabilityTrigger, DeliverabilityState]> = [
      ["unknown", "send_success", "reachable"],
      ["unknown", "permanent_number_error", "suppressed"],
      ["reachable", "permanent_number_error", "suppressed"],
      ["suppressed", "operator_override", "manually_cleared"],
      ["manually_cleared", "permanent_number_error", "suppressed"],
    ];
    for (const [from, trigger, to] of cases) {
      expect(nextDeliverabilityState(from, trigger)).toBe(to);
      expect(canTransitionDeliverabilityState(from, to, trigger)).toBe(true);
    }
  });
});
