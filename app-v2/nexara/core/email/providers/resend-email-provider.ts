import { AppError } from "../../../shared/errors";
import type { EmailMessage, EmailProvider } from "../email-provider.interface";

export interface ResendEmailConfig { readonly apiKey: string; readonly from: string; }

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  constructor(private readonly config: ResendEmailConfig) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.config.from, to: [message.to], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) }),
    });
    if (!response.ok) throw AppError.provider(`Resend email send failed (${response.status})`);
  }
}
