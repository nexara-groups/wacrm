// Public surface of the Platform layer. Business logic imports the interface
// from here; the DI container is the only place that imports a concrete
// provider implementation.
export type {
  PlatformProvider,
  KVStore,
  CacheStore,
  QueueClient,
  Scheduler,
  ScheduledHandler,
} from "./platform-provider.interface";
