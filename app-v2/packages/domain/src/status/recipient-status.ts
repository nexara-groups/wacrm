/**
 * RecipientStatus — per-recipient delivery lifecycle of a single outbound
 * message (whether sent as part of a broadcast or a single/inbox send).
 */
export type RecipientStatus = "pending" | "sent" | "delivered" | "read" | "replied" | "failed";

export const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  "pending",
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
];

const LEGAL_TRANSITIONS: Record<RecipientStatus, readonly RecipientStatus[]> = {
  pending: ["sent", "failed"],
  sent: ["delivered", "failed"],
  delivered: ["read", "replied", "failed"],
  read: ["replied"],
  replied: [],
  failed: [],
};

/** Pure predicate: is `from -> to` a legal RecipientStatus transition? */
export function canTransitionRecipientStatus(from: RecipientStatus, to: RecipientStatus): boolean {
  if (from === to) return false;
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function isTerminalRecipientStatus(status: RecipientStatus): boolean {
  return LEGAL_TRANSITIONS[status].length === 0;
}
