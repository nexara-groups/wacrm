import type { TenantId } from "../../shared/types";

/**
 * Event Bus — minimal in-process publish/subscribe.
 *
 * Deliberately NOT CQRS, event sourcing, or distributed messaging. It exists so
 * that, in the future, one part of the app can react to something another part
 * did (e.g. send a notification when a user is created) without the two
 * importing each other.
 *
 * Provider-independent: the interface lives here; the implementation lives in
 * `src/infrastructure/events`.
 */

/** Base shape every event shares. `type` is the discriminator. */
export interface DomainEvent {
  /** Stable event name, e.g. "UserCreated". */
  readonly type: string;
  /** Epoch millis the event occurred. */
  readonly occurredAt: number;
  /** Tenant the event belongs to (events are tenant-scoped where relevant). */
  readonly tenantId?: TenantId;
}

export type EventHandler<E extends DomainEvent = DomainEvent> = (
  event: E,
) => void | Promise<void>;

/** Call to remove a previously registered handler. */
export type Unsubscribe = () => void;

export interface EventBus {
  /** Publish an event to all handlers subscribed to its `type`. */
  publish<E extends DomainEvent>(event: E): Promise<void>;

  /** Subscribe a handler to an event `type`. Returns an unsubscribe function. */
  subscribe<E extends DomainEvent>(type: E["type"], handler: EventHandler<E>): Unsubscribe;
}
