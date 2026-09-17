import { describe, expect, it } from "vitest";
import {
  SERVICE_WINDOW_MS,
  isWithinServiceWindow,
  remainingWindowMs,
  requiresTemplate,
  windowClosesAt,
} from "./24h-window";

const T0 = "2026-01-01T00:00:00.000Z";

describe("isWithinServiceWindow", () => {
  it("is within the window immediately after the inbound message", () => {
    expect(isWithinServiceWindow(T0, T0)).toBe(true);
  });

  it("is within the window at 23:59:59.999 elapsed (just inside)", () => {
    const now = new Date(Date.parse(T0) + SERVICE_WINDOW_MS - 1).toISOString();
    expect(isWithinServiceWindow(T0, now)).toBe(true);
  });

  it("is within the window at exactly 24:00:00.000 elapsed (the boundary itself)", () => {
    const now = new Date(Date.parse(T0) + SERVICE_WINDOW_MS).toISOString();
    expect(isWithinServiceWindow(T0, now)).toBe(true);
  });

  it("is outside the window at 24:00:00.001 elapsed (just outside)", () => {
    const now = new Date(Date.parse(T0) + SERVICE_WINDOW_MS + 1).toISOString();
    expect(isWithinServiceWindow(T0, now)).toBe(false);
  });

  it("is outside the window well past 24h", () => {
    const now = new Date(Date.parse(T0) + SERVICE_WINDOW_MS * 3).toISOString();
    expect(isWithinServiceWindow(T0, now)).toBe(false);
  });

  it("is outside the window when there has never been an inbound message", () => {
    expect(isWithinServiceWindow(null, T0)).toBe(false);
  });

  it("treats a `now` before `lastInboundAt` (clock skew) as within the window", () => {
    const past = new Date(Date.parse(T0) - 1000).toISOString();
    expect(isWithinServiceWindow(T0, past)).toBe(true);
  });

  it("requiresTemplate is the exact negation of isWithinServiceWindow", () => {
    const justOutside = new Date(Date.parse(T0) + SERVICE_WINDOW_MS + 1).toISOString();
    expect(requiresTemplate(T0, T0)).toBe(false);
    expect(requiresTemplate(T0, justOutside)).toBe(true);
    expect(requiresTemplate(null, T0)).toBe(true);
  });
});

describe("windowClosesAt", () => {
  it("is exactly 24h after lastInboundAt", () => {
    expect(windowClosesAt(T0)).toBe(new Date(Date.parse(T0) + SERVICE_WINDOW_MS).toISOString());
  });

  it("is null when there is no inbound message", () => {
    expect(windowClosesAt(null)).toBeNull();
  });
});

describe("remainingWindowMs", () => {
  it("is the full window right at the inbound message", () => {
    expect(remainingWindowMs(T0, T0)).toBe(SERVICE_WINDOW_MS);
  });

  it("counts down linearly", () => {
    const now = new Date(Date.parse(T0) + 1000).toISOString();
    expect(remainingWindowMs(T0, now)).toBe(SERVICE_WINDOW_MS - 1000);
  });

  it("clamps to 0 once the window has closed, never negative", () => {
    const now = new Date(Date.parse(T0) + SERVICE_WINDOW_MS * 2).toISOString();
    expect(remainingWindowMs(T0, now)).toBe(0);
  });

  it("is null when there is no inbound message", () => {
    expect(remainingWindowMs(null, T0)).toBeNull();
  });
});
