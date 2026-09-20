/**
 * Message-retention sweep — the orchestration the Cron Trigger runs.
 *
 * This file is composition, not policy or persistence: it holds no SQL (the
 * "no SQL in apps/web" rule) and reimplements none of `sweepExpiredMessages`,
 * `getRetentionConfig` (modules/conversations/infrastructure/message-repository.ts)
 * or `planSweep`/`resolveRetentionDays` (modules/conversations/domain/retention.ts).
 * It only calls them, once per account, paging accounts through
 * `ModuleRepositories.accountDirectory` so the whole fleet is never loaded
 * at once.
 *
 * -----------------------------------------------------------------------
 * THE WRITE BUDGET
 * -----------------------------------------------------------------------
 * A delete is a metered D1 write, and the free tier allows 100,000 writes a
 * day for the WHOLE product, not just retention — every message send,
 * status update and webhook write competes for the same quota.
 * `RUN_WRITE_BUDGET` caps how many rows one scheduled run may delete in
 * total, across every account, so a cron misfire (or an account with years
 * of untrimmed history) can never come close to that ceiling on its own.
 * 5,000/run is 5% of the daily quota — enough to make real nightly progress
 * on a backlog while leaving essentially all of it for ordinary traffic.
 *
 * A backlog that drains over several nights, once the budget runs out
 * partway through the fleet, is the INTENDED behaviour (see
 * `domain/retention.ts`'s own header: "deleting less than asked is normal
 * operation here, not a partial failure") — this file preserves that by
 * stopping cleanly the moment the budget is spent, rather than pretending
 * the run finished. It does not keep paging the account directory just to
 * enumerate every untouched account by name once the budget is gone — that
 * would trade a bounded WRITE cost for an unbounded READ one on a large
 * fleet, for a report nobody needs at that granularity: the accounts it
 * never reached this run are exactly the ones a fresh run picks up next
 * time, automatically, because retention recomputes the cutoff live.
 *
 * -----------------------------------------------------------------------
 * FAILURE ISOLATION
 * -----------------------------------------------------------------------
 * One account's failure (a query error, a malformed retention config) is
 * caught and recorded per account; every other account still gets its sweep
 * this run. A single bad tenant must never silently stop retention for
 * everyone else.
 */
import type { ModuleRepositories } from "@modules/container";
import { createTenantContext } from "@nexara/core/context";
import { planSweep, type RetentionConfig } from "@modules/conversations/domain/retention";

/** Deletes per scheduled run, across every account combined. See file header. */
export const RUN_WRITE_BUDGET = 5_000;

/** Accounts fetched per `accountDirectory.listAccountIds` page — bounded, never the whole table. */
export const ACCOUNT_PAGE_SIZE = 50;

export interface AccountSweepFailure {
  readonly accountId: string;
  readonly error: string;
}

export interface RetentionSweepReport {
  /** Accounts whose sweep was actually attempted (successfully or not) this run. */
  readonly accountsSeen: number;
  /** Accounts whose sweep raised — the rest still ran. */
  readonly failures: readonly AccountSweepFailure[];
  /** Rows deleted this run, across every account. Never exceeds `RUN_WRITE_BUDGET`. */
  readonly totalDeleted: number;
  /**
   * `true` once the run stopped early because `RUN_WRITE_BUDGET` was spent
   * before every account could be swept. Expected on a fleet with a real
   * backlog — whatever was not reached this run is picked up by the next
   * scheduled run.
   */
  readonly budgetExhausted: boolean;
  /**
   * Accounts that were swept THIS run but still had expired messages left
   * when their own sweep stopped (their `sweepExpiredMessages` reported
   * `more: true` and the shared budget ran out before it could keep going).
   * Does NOT include accounts the run never reached at all — see the file
   * header on why those are not enumerated.
   */
  readonly accountsWithBacklogRemaining: readonly string[];
}

/**
 * One account's sweep: resolve its retention window, then delete in
 * `planSweep`-sized chunks until either `more` is false (caught up) or the
 * shared budget runs out. Never asks `sweepExpiredMessages` to delete more
 * rows than `budgetRemaining` allows (`budgetRemaining` is always > 0 here —
 * the caller stops paging before it would reach zero).
 */
async function sweepOneAccount(
  repositories: ModuleRepositories,
  accountId: string,
  now: Date,
  budgetRemaining: number,
): Promise<{ readonly deleted: number; readonly backlogRemains: boolean }> {
  const tenant = createTenantContext(accountId);
  const config: RetentionConfig = await repositories.messages.getRetentionConfig(tenant);
  const plan = planSweep(now, config);

  let deleted = 0;
  let remaining = budgetRemaining;
  for (;;) {
    const chunk = Math.min(plan.maxDeletes, remaining);
    const result = await repositories.messages.sweepExpiredMessages(tenant, plan.cutoff, chunk);
    deleted += result.deleted;
    remaining -= result.deleted;
    if (!result.more) {
      return { deleted, backlogRemains: false };
    }
    if (remaining <= 0 || result.deleted === 0) {
      // Either the shared budget is spent, or (defensively) `more: true`
      // came back with nothing actually deleted — either way, stop instead
      // of spinning, and report backlog rather than claim completion.
      return { deleted, backlogRemains: true };
    }
  }
}

export interface RetentionSweepOptions {
  /** Overrides `RUN_WRITE_BUDGET` — exposed for tests; production code should rely on the default. */
  readonly writeBudget?: number;
  /** Overrides `ACCOUNT_PAGE_SIZE` — exposed for tests; production code should rely on the default. */
  readonly accountPageSize?: number;
}

/**
 * Runs the sweep for the whole fleet, one bounded page of accounts at a
 * time, stopping the moment the write budget is spent.
 */
export async function runRetentionSweep(
  repositories: ModuleRepositories,
  now: Date = new Date(),
  options: RetentionSweepOptions = {},
): Promise<RetentionSweepReport> {
  const writeBudget = options.writeBudget ?? RUN_WRITE_BUDGET;
  const accountPageSize = options.accountPageSize ?? ACCOUNT_PAGE_SIZE;

  let accountsSeen = 0;
  let totalDeleted = 0;
  let budgetExhausted = false;
  const failures: AccountSweepFailure[] = [];
  const accountsWithBacklogRemaining: string[] = [];

  let cursor: string | null = null;
  outer: for (;;) {
    const page = await repositories.accountDirectory.listAccountIds(cursor, accountPageSize);
    for (const accountId of page.accountIds) {
      if (totalDeleted >= writeBudget) {
        budgetExhausted = true;
        break outer;
      }
      accountsSeen += 1;
      try {
        const { deleted, backlogRemains } = await sweepOneAccount(
          repositories,
          accountId,
          now,
          writeBudget - totalDeleted,
        );
        totalDeleted += deleted;
        if (backlogRemains) {
          accountsWithBacklogRemaining.push(accountId);
          // The only way `sweepOneAccount` reports backlog is the shared
          // budget running out mid-account (or its zero-progress defensive
          // branch) — either way, this run did not fully catch this account
          // up, so the run as a whole counts as budget-exhausted even when
          // it happened to be the very last account on the very last page.
          if (totalDeleted >= writeBudget) {
            budgetExhausted = true;
          }
        }
      } catch (error) {
        // ONE account's failure is caught and recorded here — the loop
        // moves on to the next account either way. This is the only place
        // that must never let a per-account error escape the run.
        failures.push({
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }

  return {
    accountsSeen,
    failures,
    totalDeleted,
    budgetExhausted,
    accountsWithBacklogRemaining,
  };
}
