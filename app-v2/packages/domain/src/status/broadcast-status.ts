/**
 * BroadcastStatus — lifecycle of a broadcast/campaign run.
 */
export type BroadcastStatus = "draft" | "scheduled" | "sending" | "sent" | "failed";

export const BROADCAST_STATUSES: readonly BroadcastStatus[] = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "failed",
];

const LEGAL_TRANSITIONS: Record<BroadcastStatus, readonly BroadcastStatus[]> = {
  draft: ["scheduled", "sending"],
  scheduled: ["draft", "sending", "failed"],
  sending: ["sent", "failed"],
  sent: [],
  failed: [],
};

/** Pure predicate: is `from -> to` a legal BroadcastStatus transition? */
export function canTransitionBroadcastStatus(from: BroadcastStatus, to: BroadcastStatus): boolean {
  if (from === to) return false;
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** `sent` and `failed` are terminal — no further transitions out. */
export function isTerminalBroadcastStatus(status: BroadcastStatus): boolean {
  return LEGAL_TRANSITIONS[status].length === 0;
}
