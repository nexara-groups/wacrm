import { AppError } from "../../../shared/errors";
import type {
  CacheStore,
  KVStore,
  PlatformProvider,
  QueueClient,
  ScheduledHandler,
  Scheduler,
} from "../platform-provider.interface";

/**
 * Minimal structural types for the Cloudflare Workers bindings this provider
 * consumes. Declared locally so the foundation does not hard-depend on
 * `@cloudflare/workers-types` at the interface level. In a real deployment
 * these line up with the generated `CloudflareEnv` (see `npm run cf-typegen`).
 */
interface CfKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CfQueue {
  send(message: unknown, opts?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: ReadonlyArray<{ body: unknown }>): Promise<void>;
}

/** The environment object Cloudflare passes to the Worker. */
export interface CloudflareBindings {
  [key: string]: unknown;
  DB?: unknown;
  NEXARA_MEDIA?: unknown;
  NEXARA_KV?: CfKVNamespace;
  NEXARA_QUEUE?: CfQueue;
}

/**
 * CloudflarePlatformProvider — the only place in the codebase allowed to touch
 * Cloudflare-specific binding shapes. Everything else uses PlatformProvider.
 */
export class CloudflarePlatformProvider implements PlatformProvider {
  readonly name = "cloudflare";

  private readonly schedulers = new Map<string, ScheduledHandler[]>();

  constructor(private readonly env: CloudflareBindings) {}

  getEnv(key: string): string | undefined {
    const value = this.env[key];
    return typeof value === "string" ? value : undefined;
  }

  requireEnv(key: string): string {
    const value = this.getEnv(key);
    if (value === undefined) {
      throw AppError.platform(`Missing required environment variable: ${key}`);
    }
    return value;
  }

  kv(namespace = "NEXARA_KV"): KVStore {
    const ns = this.env[namespace] as CfKVNamespace | undefined;
    if (!ns) throw AppError.platform(`KV namespace not bound: ${namespace}`);
    return {
      get: (key) => ns.get(key),
      put: (key, value, opts) =>
        ns.put(key, value, opts?.ttlSeconds ? { expirationTtl: opts.ttlSeconds } : undefined),
      delete: (key) => ns.delete(key),
    };
  }

  cache(): CacheStore {
    // Cache is implemented on top of KV with JSON encoding.
    const store = this.kv("NEXARA_KV");
    return {
      async get<T>(key: string): Promise<T | null> {
        const raw = await store.get(key);
        return raw === null ? null : (JSON.parse(raw) as T);
      },
      async set<T>(key: string, value: T, opts?: { ttlSeconds?: number }): Promise<void> {
        await store.put(key, JSON.stringify(value), opts);
      },
      delete: (key) => store.delete(key),
    };
  }

  queue(): QueueClient {
    const q = this.env.NEXARA_QUEUE;
    if (!q) throw AppError.platform("Queue not bound: NEXARA_QUEUE");
    return {
      enqueue: (message, opts) =>
        q.send(message, opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined),
      enqueueBatch: (messages) => q.sendBatch(messages.map((body) => ({ body }))),
    };
  }

  scheduler(): Scheduler {
    const map = this.schedulers;
    return {
      register(cron: string, handler: ScheduledHandler): void {
        const list = map.get(cron) ?? [];
        list.push(handler);
        map.set(cron, list);
      },
      handlersFor(cron: string): readonly ScheduledHandler[] {
        return map.get(cron) ?? [];
      },
    };
  }
}
