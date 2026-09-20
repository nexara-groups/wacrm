import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DELETES_PER_SWEEP,
  MIN_RETENTION_DAYS,
  planSweep,
  resolveRetentionDays,
  retentionCutoff,
  selectExpired,
} from "./retention";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const PLATFORM_DEFAULT = 60;

describe("resolveRetentionDays", () => {
  it("uses the platform default when the account has no override", () => {
    expect(
      resolveRetentionDays({
        accountRetentionDaysOverride: null,
        platformDefaultRetentionDays: PLATFORM_DEFAULT,
      }),
    ).toBe(60);
  });

  it("an account override wins over the platform default, in both directions", () => {
    expect(
      resolveRetentionDays({ accountRetentionDaysOverride: 180, platformDefaultRetentionDays: 60 }),
    ).toBe(180);
    expect(
      resolveRetentionDays({ accountRetentionDaysOverride: 7, platformDefaultRetentionDays: 60 }),
    ).toBe(7);
  });

  it("never resolves below one day, so a `0` cannot mean 'delete everything'", () => {
    // `0` is what someone types when they mean "no limit". Honouring it
    // literally would continuously destroy every message. A configuration
    // mistake should cost storage, never history.
    for (const bad of [0, -1, -9999]) {
      expect(
        resolveRetentionDays({
          accountRetentionDaysOverride: bad,
          platformDefaultRetentionDays: PLATFORM_DEFAULT,
        }),
      ).toBe(MIN_RETENTION_DAYS);
    }
  });
});

describe("retentionCutoff", () => {
  it("is exactly N days before now", () => {
    expect(retentionCutoff(NOW, 60).toISOString()).toBe("2026-07-21T12:00:00.000Z");
  });

  it("keeps a message sitting exactly on the cutoff", () => {
    // A 60-day policy that drops a message on its 60th day has kept 59.
    const cutoff = retentionCutoff(NOW, 60);
    const plan = planSweep(NOW, {
      accountRetentionDaysOverride: null,
      platformDefaultRetentionDays: 60,
    });
    const onTheBoundary = [{ id: "m1", createdAt: cutoff.toISOString() }];
    expect(selectExpired(onTheBoundary, plan)).toEqual([]);
  });
});

describe("selectExpired", () => {
  const plan = planSweep(NOW, {
    accountRetentionDaysOverride: null,
    platformDefaultRetentionDays: 60,
  });

  it("selects only messages older than the cutoff", () => {
    const messages = [
      { id: "ancient", createdAt: "2020-01-01T00:00:00.000Z" },
      { id: "just-expired", createdAt: "2026-07-21T11:59:59.000Z" },
      { id: "just-kept", createdAt: "2026-07-21T12:00:01.000Z" },
      { id: "today", createdAt: NOW.toISOString() },
    ];
    expect(selectExpired(messages, plan).map((m) => m.id)).toEqual(["ancient", "just-expired"]);
  });

  it("never returns more than maxDeletes, so one sweep stays a bounded write", () => {
    // A delete is a metered write on D1, and the first sweep of an
    // account that has never been trimmed could otherwise be its whole
    // history in one statement.
    const messages = Array.from({ length: 2_500 }, (_, i) => ({
      id: `m${i}`,
      createdAt: "2020-01-01T00:00:00.000Z",
    }));
    expect(selectExpired(messages, plan)).toHaveLength(DEFAULT_MAX_DELETES_PER_SWEEP);

    const smaller = planSweep(
      NOW,
      { accountRetentionDaysOverride: null, platformDefaultRetentionDays: 60 },
      50,
    );
    expect(selectExpired(messages, smaller)).toHaveLength(50);
  });

  it("returns nothing when everything is inside the window", () => {
    const messages = [
      { id: "a", createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "b", createdAt: NOW.toISOString() },
    ];
    expect(selectExpired(messages, plan)).toEqual([]);
  });
});
