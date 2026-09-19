import type { AccountId, BroadcastId, TemplateId, UserId } from "../ids";
import type { BroadcastStatus } from "../status/broadcast-status";
import type { ISODateString } from "./common";

export interface Broadcast {
  readonly id: BroadcastId;
  readonly accountId: AccountId;
  readonly name: string;
  readonly templateId: TemplateId;
  readonly status: BroadcastStatus;
  readonly scheduledAt: ISODateString | null;
  readonly createdBy: UserId;
  readonly totalRecipients: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}
