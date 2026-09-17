import { AppError } from "../../../shared/errors";
import type { EmailMessage, EmailProvider } from "../email-provider.interface";

const EMAIL_LOCAL_PART = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
const DOMAIN_LABEL = /^[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i;

function isValidEmailAddress(address: string): boolean {
  if (address.length > 254) return false;
  const separator = address.indexOf("@");
  if (separator <= 0 || separator !== address.lastIndexOf("@")) return false;
  const local = address.slice(0, separator);
  const domain = address.slice(separator + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !EMAIL_LOCAL_PART.test(local) || domain.length > 253) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}

export function parseRecipientAllowlist(value: string | undefined): ReadonlySet<string> {
  const recipients = value?.split(",").map((recipient) => recipient.trim().toLowerCase());
  if (!recipients?.length || recipients.some((recipient) => !isValidEmailAddress(recipient))) {
    throw AppError.provider("Staging email recipient allowlist is invalid");
  }
  return new Set(recipients);
}

export class RecipientAllowlistEmailProvider implements EmailProvider {
  private readonly recipients: ReadonlySet<string>;

  constructor(private readonly inner: EmailProvider, recipients: ReadonlySet<string>) {
    this.recipients = parseRecipientAllowlist([...recipients].join(","));
  }

  get name(): string { return this.inner.name; }

  async send(message: EmailMessage): Promise<void> {
    if (!this.recipients.has(message.to.trim().toLowerCase())) {
      throw AppError.provider("Staging email recipient is not allowlisted");
    }
    await this.inner.send(message);
  }
}
