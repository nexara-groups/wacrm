/**
 * Ambient module declaration for the OpenNext/Cloudflare-GENERATED worker
 * (`.open-next/worker.js`), imported by `cf-entry.ts` through the
 * non-relative `cf-open-next-worker` alias — see that file's header, and
 * `tsconfig.json`'s `paths` entry for the same name, for why a relative
 * import cannot carry an ambient declaration here (TS2436).
 *
 * Declares only the shape `cf-entry.ts` actually touches: the three
 * Durable Object exports (re-exported unchanged, never constructed or
 * inspected by this app) and a default export with the one method this
 * wrapper calls, `fetch`. It deliberately does NOT attempt to fully type
 * the generated worker's internals — that module belongs to OpenNext, not
 * this app, and doing so would only be duplicated, driftable guesswork.
 * `env`/`ctx` are typed `unknown` here for the same reason: this file never
 * inspects them, only forwards whatever Cloudflare hands it straight into
 * the generated worker's own `fetch`.
 */
declare module "cf-open-next-worker" {
  export const DOQueueHandler: unknown;
  export const DOShardedTagCache: unknown;
  export const BucketCachePurge: unknown;

  interface OpenNextWorker {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  }

  const worker: OpenNextWorker;
  export default worker;
}
