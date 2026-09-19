/** Vendor-neutral outbound transactional message. */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
