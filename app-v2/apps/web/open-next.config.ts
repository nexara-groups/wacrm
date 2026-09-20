// OpenNext config for the Cloudflare adapter (@opennextjs/cloudflare).
//
// Deliberately minimal: no R2 incremental cache, no KV tag cache, no queue
// override. Those all need a Cloudflare resource this task is not allowed
// to create (see docs/cloudflare-deploy.md). Leaving them unset falls back
// to OpenNext's "dummy" cache/queue implementations, which is a real,
// supported mode (in-memory, request-scoped — no ISR persistence across
// requests) rather than a broken default. A human who wants persistent ISR
// caching adds the R2 bucket + binding later; nothing here blocks that.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
