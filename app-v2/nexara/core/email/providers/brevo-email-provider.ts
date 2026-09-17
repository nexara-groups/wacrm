import { AppError } from "../../../shared/errors";
import type { EmailMessage, EmailProvider } from "../email-provider.interface";

export interface BrevoEmailConfig { readonly apiKey: string; readonly fromEmail: string; readonly fromName: string; }

export class BrevoEmailProvider implements EmailProvider {
  readonly name = "brevo";
  constructor(private readonly config: BrevoEmailConfig) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": this.config.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ sender: { email: this.config.fromEmail, name: this.config.fromName }, to: [{ email: message.to }], subject: message.subject, textContent: message.text, ...(message.html ? { htmlContent: message.html } : {}) }),
    });
    if (!response.ok) throw AppError.provider(`Brevo email send failed (${response.status})`);
  }
}
