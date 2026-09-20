/**
 * Cloud Platform Layer — abstraction over the runtime/cloud platform.
 *
 * Responsibilities: environment variables, KV access, queue access,
 * scheduled jobs, cache access.
 *
 * Business logic depends ONLY on this interface, never on Cloudflare- (or AWS-)
 * specific APIs. Swapping CloudflarePlatformProvider for AWSPlatformProvider
 * must require zero business-code changes.
 */

/** Key/value store abstraction (Cloudflare KV, DynamoDB, Redis, ...). */
export interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Cache abstraction. JSON-serializable values with TTL. */
export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Queue abstraction for async/background work. */
export interface QueueClient {
  /** Enqueue a single message onto the named (or default) queue. */
  enqueue<T>(message: T, opts?: { queue?: string; delaySeconds?: number }): Promise<void>;
  /** Enqueue a batch of messages. */
  enqueueBatch<T>(messages: readonly T[], opts?: { queue?: string }): Promise<void>;
}

/** A handler invoked by the platform's scheduler (cron). */
export type ScheduledHandler = (event: { cron: string; scheduledTime: number }) => Promise<void>;

/** Registry for scheduled (cron) jobs. */
export interface Scheduler {
  /** Register a handler for a cron expression. Invoked by the platform runtime. */
  register(cron: string, handler: ScheduledHandler): void;
  /** Look up handlers registered for a cron expression. */
  handlersFor(cron: string): readonly ScheduledHandler[];
}

export interface PlatformProvider {
  /** Provider identifier, e.g. "cloudflare" | "aws". */
  readonly name: string;

  /** Read an environment variable / binding-backed config value. */
  getEnv(key: string): string | undefined;
  /** Read a required env var, throwing AppError("PLATFORM") if missing. */
  requireEnv(key: string): string;

  /** Named KV store. */
  kv(namespace?: string): KVStore;
  /** Cache store (JSON values). */
  cache(): CacheStore;
  /** Queue client. */
  queue(): QueueClient;
  /** Scheduled-jobs registry. */
  scheduler(): Scheduler;
}
