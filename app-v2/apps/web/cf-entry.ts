/**
 * Wrangler `main` entry — wraps the OpenNext/Cloudflare-GENERATED worker so
 * this app can have a `scheduled()` handler (Cloudflare Cron Trigger) at
 * all.
 *
 * `opennextjs-cloudflare build` writes `.open-next/worker.js` fresh on
 * every build (see that file's own header comment) and it exports only a
 * `fetch` default export plus three Durable Object classes — there is
 * nowhere in it to add a cron handler, and editing it directly would be
 * silently thrown away by the next build (it is build OUTPUT, not source).
 *
 * This file is the fixed point instead: `wrangler.jsonc`'s `main` points
 * here, not at the generated file. It imports the generated worker,
 * re-exports its `fetch` and EVERY Durable Object export UNCHANGED
 * (dropping one breaks that binding silently — checked directly against
 * the generated file's own exports: `grep '^export ' .open-next/worker.js`
 * lists `DOQueueHandler`, `DOShardedTagCache`, `BucketCachePurge` as of
 * this writing), and adds the one thing it lacks: `scheduled()`.
 *
 * -----------------------------------------------------------------------
 * THE IMPORT, AND WHY IT GOES THROUGH AN ALIAS INSTEAD OF A RELATIVE PATH
 * -----------------------------------------------------------------------
 * `.open-next/worker.js` does not exist until `cf:build` has run at least
 * once — a fresh checkout, or right after `git clean`, has no such file. A
 * plain relative import (`from "./.open-next/worker.js"`) has no honest
 * escape hatch for that gap: TypeScript rejects a `declare module` whose
 * name is a relative path outright —
 *   `TS2436: Ambient module declaration cannot specify relative module name`
 * — build or no build, so no `.d.ts` next to this file can paper over a
 * missing relative import. (Verified directly, not assumed.)
 *
 * The import below instead goes through the NON-relative alias
 * `cf-open-next-worker` (mapped to `./.open-next/worker.js` in this app's
 * `tsconfig.json` `paths`), which `cf-open-next-worker.d.ts` (next to this
 * file) declares an ambient module for — allowed for a non-relative name.
 * Verified locally:
 *   - `tsc --noEmit` is clean with NO generated file present (the ambient
 *     declaration is all there is to resolve against).
 *   - `tsc --noEmit` is clean again AFTER a real `cf:build` (the ambient
 *     declaration still wins over the plain, type-less generated `.js`, so
 *     the check never depends on whatever loose types that build output
 *     happens to have).
 *   - `wrangler` bundles with esbuild, which understands tsconfig `paths`
 *     natively and resolves this alias to the real generated file when it
 *     exists — `npx wrangler deploy --dry-run` after a real `cf:build`
 *     confirms the DEPLOYED worker gets the real file, not a stub.
 *
 * The alternative the task explicitly allows — adding this file to
 * `tsconfig.json`'s `exclude` — was passed over because it would turn off
 * type-checking for `scheduled()` itself, the one piece of new logic this
 * file adds; the alias keeps that checked and only works around the
 * genuinely un-typeable part (an import of a file that is build output).
 */
import openNextWorker, {
  DOQueueHandler,
  DOShardedTagCache,
  BucketCachePurge,
} from "cf-open-next-worker";
import {
  D1DatabaseProvider,
  type D1DatabaseBinding,
} from "@nexara/core/database/providers/d1-database-provider";
import { buildModuleRepositories } from "@modules/container";
import { runRetentionSweep, type RetentionSweepReport } from "./lib/retention-sweep";

/**
 * Minimal structural types for the two Workers-runtime values `scheduled()`
 * receives. This project does not depend on `@cloudflare/workers-types`
 * (not installed) — `D1DatabaseProvider`'s own `D1DatabaseBinding` follows
 * the same pattern: a small structural interface per binding instead of an
 * ambient global.
 */
interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

/** Only the one binding this handler reads: `env.DB`, same as `lib/container.ts`. */
interface ScheduledEnv {
  readonly DB?: D1DatabaseBinding;
}

function logReport(report: RetentionSweepReport): void {
  console.log(
    "retention sweep: " +
      `accountsSeen=${report.accountsSeen} deleted=${report.totalDeleted} ` +
      `budgetExhausted=${report.budgetExhausted} failures=${report.failures.length} ` +
      `accountsWithBacklogRemaining=${report.accountsWithBacklogRemaining.length}`,
  );
  for (const failure of report.failures) {
    console.error(`retention sweep: account "${failure.accountId}" failed: ${failure.error}`);
  }
  if (report.budgetExhausted) {
    // Not an error: see retention-sweep.ts's header. A backlog draining
    // over several nights, once the write budget runs out, is the
    // intended behaviour, not a failure — this line exists so it is
    // VISIBLE, not so it pages anyone.
    console.warn(
      "retention sweep: write budget exhausted this run — remaining backlog " +
        `(${report.accountsWithBacklogRemaining.length} account(s) not fully caught up) ` +
        "will drain on subsequent scheduled runs",
    );
  }
}

/**
 * The nightly retention sweep — see `lib/retention-sweep.ts` for the actual
 * work (write budget, per-account failure isolation, account paging).
 *
 * Schedule: `0 9 * * *` (see `wrangler.jsonc`'s `triggers.crons`) — once a
 * day, 09:00 UTC:
 *   - Once a day matches the policy's own granularity
 *     (`message_retention_days` is a day count); running more often would
 *     spend extra D1 read/write quota re-checking a cutoff that has not
 *     moved.
 *   - 09:00 UTC falls outside both US and EU/UK business-hours peaks (it is
 *     ~1-5am across the Americas and mid-morning-to-afternoon across
 *     Europe, i.e. never every account's own "busy" window at once, but
 *     reliably a quieter one for the aggregate), so the sweep's writes
 *     compete least with request-time D1 usage for the shared daily quota.
 */
async function scheduled(
  _controller: ScheduledController,
  env: ScheduledEnv,
  _ctx: unknown,
): Promise<void> {
  if (!env.DB) {
    console.error('retention sweep: missing D1 binding "DB" — skipping this run');
    return;
  }
  const database = new D1DatabaseProvider({ db: env.DB });
  const repositories = buildModuleRepositories(database);
  const report = await runRetentionSweep(repositories, new Date());
  logReport(report);
}

export default {
  fetch: openNextWorker.fetch,
  scheduled,
};

// Re-exported UNCHANGED — see this file's header. Cloudflare wires these to
// `durable_objects` bindings (if/when any are configured) by export name;
// dropping one here would silently break that binding without a build
// error anywhere.
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge };
