import { describe, expect, it } from "vitest";
import {
  buildInvitationAcceptUrl,
  buildInvitationEmail,
  buildVerificationEmail,
  buildVerifyEmailUrl,
  resolveAppBaseUrl,
} from "./email-templates";

describe("resolveAppBaseUrl", () => {
  it("falls back to the local dev server when APP_BASE_URL is unset", () => {
    expect(resolveAppBaseUrl({})).toBe("http://localhost:3000");
  });

  it("uses APP_BASE_URL when set, stripping a trailing slash", () => {
    expect(resolveAppBaseUrl({ APP_BASE_URL: "https://app.example.test/" })).toBe("https://app.example.test");
  });
});

describe("buildInvitationAcceptUrl / buildVerifyEmailUrl", () => {
  it("URL-encodes the token into the link", () => {
    const url = buildInvitationAcceptUrl("raw token/with+special=chars", { APP_BASE_URL: "https://app.test" });
    expect(url).toBe(
      `https://app.test/accept-invite?token=${encodeURIComponent("raw token/with+special=chars")}`,
    );
  });

  it("builds a distinct verify-email link", () => {
    const url = buildVerifyEmailUrl("tok", { APP_BASE_URL: "https://app.test" });
    expect(url).toBe("https://app.test/verify-email?token=tok");
  });
});

describe("buildInvitationEmail / buildVerificationEmail", () => {
  it("carries the accept link in both text and html", () => {
    const message = buildInvitationEmail({ to: "a@x.test", role: "admin", acceptUrl: "https://app.test/accept-invite?token=abc" });
    expect(message.to).toBe("a@x.test");
    expect(message.text).toContain("https://app.test/accept-invite?token=abc");
    expect(message.html).toContain("https://app.test/accept-invite?token=abc");
    expect(message.text).toContain("admin");
  });

  it("carries the verify link in both text and html", () => {
    const message = buildVerificationEmail({ to: "a@x.test", verifyUrl: "https://app.test/verify-email?token=abc" });
    expect(message.to).toBe("a@x.test");
    expect(message.text).toContain("https://app.test/verify-email?token=abc");
    expect(message.html).toContain("https://app.test/verify-email?token=abc");
  });
});
