import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage, EmailProvider } from "@nexara/core/email";
import { sendInvitationEmail } from "./invitation-email";
import { buildInvitationAcceptUrl } from "./email-templates";

const RAW_TOKEN = "extremely-secret-raw-invitation-token-do-not-log-me";

class ThrowingProvider implements EmailProvider {
  readonly name = "throwing";
  async send(message: EmailMessage): Promise<void> {
    // Adversarial: even if a provider's own failure echoes the message it
    // was given (which none of the real ones do), this file's catch block
    // must never surface it — see invitation-email.ts's header.
    throw new Error(`send failed for ${message.to}: ${message.text}`);
  }
}

class RecordingProvider implements EmailProvider {
  readonly name = "recording";
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

describe("sendInvitationEmail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports success and includes the accept link when the provider accepts the message", async () => {
    const provider = new RecordingProvider();
    const acceptUrl = buildInvitationAcceptUrl(RAW_TOKEN, { APP_BASE_URL: "https://app.example.test" });

    const result = await sendInvitationEmail({ emailProvider: provider, to: "invitee@x.test", role: "admin", acceptUrl });

    expect(result).toEqual({ emailSent: true });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.to).toBe("invitee@x.test");
    // The link (and therefore the token) belongs in the EMAIL BODY — that's
    // the whole point of sending it. What must never happen is the token
    // ending up in a LOG or an ERROR MESSAGE — see the next test.
    expect(provider.sent[0]?.text).toContain(RAW_TOKEN);
  });

  it("reports failure without throwing, and never puts the raw token in the response or in any log", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const acceptUrl = buildInvitationAcceptUrl(RAW_TOKEN, { APP_BASE_URL: "https://app.example.test" });

    const result = await sendInvitationEmail({
      emailProvider: new ThrowingProvider(),
      to: "invitee@x.test",
      role: "member",
      acceptUrl,
    });

    expect(result.emailSent).toBe(false);
    expect(result.emailError).toBeTruthy();
    expect(result.emailError).not.toContain(RAW_TOKEN);

    const loggedText = [...errorSpy.mock.calls, ...logSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((v) => String(v))
      .join(" | ");
    expect(loggedText).not.toContain(RAW_TOKEN);
  });
});
