import { AppError } from "../../../shared/errors";
import type { EmailMessage, EmailProvider } from "../email-provider.interface";

export class UnavailableEmailProvider implements EmailProvider {
  readonly name = "unavailable";

  async send(_message: EmailMessage): Promise<void> {
    throw AppError.provider("Transactional email is not configured");
  }
}
