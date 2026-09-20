import type { DomainEvent } from "./event-bus";
import type { UserId } from "../../shared/types";

/**
 * Event catalog — the events the foundation knows about today. Modules add
 * their own event interfaces the same way (extend DomainEvent with a unique
 * `type` literal).
 *
 * NOTE: `TaskCreated` is an example event name only — there is no Tasks module.
 * These three are the examples named in the spec to show the shape.
 */

export interface UserCreated extends DomainEvent {
  readonly type: "UserCreated";
  readonly userId: UserId;
  readonly email: string;
}

export interface TaskCreated extends DomainEvent {
  readonly type: "TaskCreated";
  readonly taskId: string;
}

export interface NotificationSent extends DomainEvent {
  readonly type: "NotificationSent";
  readonly channel: string;
  readonly recipientId: UserId;
}

/** Union of foundation-level events (extend per module as needed). */
export type KnownEvent = UserCreated | TaskCreated | NotificationSent;
