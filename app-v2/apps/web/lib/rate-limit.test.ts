import { describe, expect, it, vi } from "vitest";
import { applyRateLimit, clientAddress } from "./rate-limit";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/auth/login", { method: "POST", headers });
}

const allowingLimiter = { limit: vi.fn(async () => ({ success: true })) };
const blockingLimiter = { limit: vi.fn(async () => ({ success: false })) };

describe("clientAddress", () => {
  it("reads CF-Connecting-IP, which Cloudflare's own edge sets", () => {
    expect(clientAddress(req({ "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("does NOT fall back to X-Forwarded-For, which a client controls", () => {
    // Honouring it would let an attacker mint a fresh quota per request by
    // varying the header — worse than having no limiter, because it would
    // look like one was working.
    expect(clientAddress(req({ "x-forwarded-for": "203.0.113.7" }))).toBeNull();
    expect(clientAddress(req())).toBeNull();
  });
});

describe("applyRateLimit", () => {
  it("blocks when the limiter says the budget is spent", async () => {
    const outcome = await applyRateLimit(req({ "cf-connecting-ip": "1.2.3.4" }), "login", blockingLimiter);
    expect(outcome).toEqual({ allowed: false, enforced: true });
  });

  it("allows, and reports enforcement, when the limiter says there is budget", async () => {
    const outcome = await applyRateLimit(req({ "cf-connecting-ip": "1.2.3.4" }), "login", allowingLimiter);
    expect(outcome).toEqual({ allowed: true, enforced: true });
  });

  it("keys on the bucket AND the address, so one endpoint cannot exhaust another", async () => {
    const limiter = { limit: vi.fn(async () => ({ success: true })) };
    await applyRateLimit(req({ "cf-connecting-ip": "1.2.3.4" }), "login", limiter);
    await applyRateLimit(req({ "cf-connecting-ip": "1.2.3.4" }), "signup", limiter);
    expect(limiter.limit).toHaveBeenNthCalledWith(1, { key: "login:1.2.3.4" });
    expect(limiter.limit).toHaveBeenNthCalledWith(2, { key: "signup:1.2.3.4" });
  });

  it("fails OPEN when no limiter is bound, and says it did not enforce", async () => {
    // Defence in depth: an absent binding must not take login down for
    // everyone. `enforced: false` is how a caller can tell the difference
    // between "allowed within budget" and "not checked at all".
    const outcome = await applyRateLimit(req({ "cf-connecting-ip": "1.2.3.4" }), "login", undefined);
    expect(outcome).toEqual({ allowed: true, enforced: false });
  });

  it("fails OPEN when the limiter throws", async () => {
    const broken = { limit: async () => { throw new Error("binding unavailable"); } };
    const outcome = await applyRateLimit(req({ "cf-connecting-ip": "1.2.3.4" }), "login", broken);
    expect(outcome).toEqual({ allowed: true, enforced: false });
  });

  it("does not call the limiter at all without a Cloudflare-supplied address", async () => {
    const limiter = { limit: vi.fn(async () => ({ success: true })) };
    const outcome = await applyRateLimit(req({ "x-forwarded-for": "9.9.9.9" }), "login", limiter);
    expect(outcome.enforced).toBe(false);
    expect(limiter.limit).not.toHaveBeenCalled();
  });
});
