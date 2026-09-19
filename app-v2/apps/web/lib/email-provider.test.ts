import { describe, expect, it } from "vitest";
import { isRealEmailProviderConfigured, selectEmailProvider } from "./email-provider";

describe("selectEmailProvider", () => {
  it("defaults to the console provider in dev when nothing is configured", () => {
    const provider = selectEmailProvider({}, "dev");
    expect(provider.name).toBe("console");
  });

  it("defaults to the unavailable provider on a real deployment with nothing configured — fails loudly, never silently", async () => {
    const provider = selectEmailProvider({}, "workers");
    expect(provider.name).toBe("unavailable");
    await expect(provider.send({ to: "a@b.test", subject: "s", text: "t" })).rejects.toThrow();
  });

  it("EMAIL_PROVIDER=console forces the console provider even on workers", () => {
    const provider = selectEmailProvider({ EMAIL_PROVIDER: "console" }, "workers");
    expect(provider.name).toBe("console");
  });

  it("builds a Resend provider from EMAIL_PROVIDER + its credentials", () => {
    const provider = selectEmailProvider(
      { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "key", EMAIL_FROM: "noreply@x.test" },
      "workers",
    );
    expect(provider.name).toBe("resend");
  });

  it("builds an SES provider from EMAIL_PROVIDER + its credentials", () => {
    const provider = selectEmailProvider(
      {
        EMAIL_PROVIDER: "ses",
        SES_REGION: "us-east-1",
        SES_ACCESS_KEY_ID: "id",
        SES_SECRET_ACCESS_KEY: "secret",
        EMAIL_FROM: "noreply@x.test",
      },
      "workers",
    );
    expect(provider.name).toBe("ses");
  });

  it("builds a Brevo provider from EMAIL_PROVIDER + its credentials", () => {
    const provider = selectEmailProvider(
      { EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "key", EMAIL_FROM: "noreply@x.test" },
      "workers",
    );
    expect(provider.name).toBe("brevo");
  });

  it("fails LOUDLY (throws) rather than silently when a real vendor is requested without its credentials", () => {
    expect(() => selectEmailProvider({ EMAIL_PROVIDER: "resend" }, "workers")).toThrow(/RESEND_API_KEY/);
  });

  it("rejects an unknown EMAIL_PROVIDER value instead of guessing", () => {
    expect(() => selectEmailProvider({ EMAIL_PROVIDER: "sendgrid" }, "dev")).toThrow(/Unknown EMAIL_PROVIDER/);
  });

  it("wraps the selected provider in the recipient allowlist when one is configured", async () => {
    const provider = selectEmailProvider(
      { EMAIL_PROVIDER: "console", EMAIL_RECIPIENT_ALLOWLIST: "allowed@x.test" },
      "dev",
    );
    // The allowlist wrapper keeps the inner provider's name (see
    // RecipientAllowlistEmailProvider.name) but refuses an address not on it.
    expect(provider.name).toBe("console");
    await expect(
      provider.send({ to: "not-allowed@x.test", subject: "s", text: "t" }),
    ).rejects.toThrow(/not allowlisted/);
    await expect(provider.send({ to: "allowed@x.test", subject: "s", text: "t" })).resolves.toBeUndefined();
  });
});

describe("isRealEmailProviderConfigured", () => {
  it("is false with nothing configured", () => {
    expect(isRealEmailProviderConfigured({})).toBe(false);
  });

  it("is false for console/unavailable — neither can actually deliver mail", () => {
    expect(isRealEmailProviderConfigured({ EMAIL_PROVIDER: "console" })).toBe(false);
    expect(isRealEmailProviderConfigured({ EMAIL_PROVIDER: "unavailable" })).toBe(false);
  });

  it("is true for resend/ses/brevo", () => {
    expect(isRealEmailProviderConfigured({ EMAIL_PROVIDER: "resend" })).toBe(true);
    expect(isRealEmailProviderConfigured({ EMAIL_PROVIDER: "ses" })).toBe(true);
    expect(isRealEmailProviderConfigured({ EMAIL_PROVIDER: "brevo" })).toBe(true);
  });
});
