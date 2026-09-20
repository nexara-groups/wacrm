import type {
  DomainEvent,
  EventBus,
  EventHandler,
  Unsubscribe,
} from "../../core/events";

/**
 * In-memory EventBus implementation.
 *
 * Synchronous, single-process pub/sub. On Cloudflare Workers each request runs
 * in an isolate, so subscriptions live for the lifetime of one container/
 * request — register handlers at composition time (in the DI container), not
 * per request. For durable or cross-request delivery, publish to
 * PlatformProvider.queue() instead; this bus is for in-process decoupling only.
 */
export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  async publish<E extends DomainEvent>(event: E): Promise<void> {
    const subscribers = this.handlers.get(event.type);
    if (!subscribers || subscribers.size === 0) return;
    // Run handlers concurrently; a handler error rejects publish().
    await Promise.all([...subscribers].map((handler) => handler(event)));
  }

  subscribe<E extends DomainEvent>(type: E["type"], handler: EventHandler<E>): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler as EventHandler);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler as EventHandler);
    };
  }
}
