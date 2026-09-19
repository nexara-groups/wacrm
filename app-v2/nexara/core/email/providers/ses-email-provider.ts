import { AwsClient } from "aws4fetch";
import { AppError } from "../../../shared/errors";
import type { EmailMessage, EmailProvider } from "../email-provider.interface";

export interface SesClient { fetch(input: string, init: RequestInit): Promise<Response>; }
export interface SesEmailConfig {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly from: string;
  readonly client?: SesClient;
}

export class SesEmailProvider implements EmailProvider {
  readonly name = "ses";
  private readonly client: SesClient;

  constructor(private readonly config: SesEmailConfig) {
    this.client = config.client ?? new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "ses",
      region: config.region,
      retries: 0,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    let response: Response;
    try {
      response = await this.client.fetch(`https://email.${this.config.region}.amazonaws.com/v2/email/outbound-emails`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          FromEmailAddress: this.config.from,
          Destination: { ToAddresses: [message.to] },
          Content: { Simple: { Subject: { Data: message.subject, Charset: "UTF-8" }, Body: { Text: { Data: message.text, Charset: "UTF-8" }, ...(message.html ? { Html: { Data: message.html, Charset: "UTF-8" } } : {}) } } },
        }),
      });
    } catch {
      throw AppError.provider("SES email send failed");
    }
    if (!response.ok) throw AppError.provider(`SES email send failed (${response.status})`);
  }
}
