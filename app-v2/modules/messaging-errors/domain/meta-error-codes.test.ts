import { describe, expect, it } from "vitest";
import { Disposition } from "./disposition";
import {
  CODE_131009_GENERIC_PARAMETER,
  META_ERROR_CODES,
  NETWORK_ERROR_ENTRY,
  PERMISSION_DENIED_RANGE,
  UNKNOWN_ERROR_ENTRY,
} from "./meta-error-codes";

/** Every code from spec §3, mapped to its expected disposition. */
const EXPECTED: ReadonlyArray<readonly [string, Disposition]> = [
  // PERMANENT_NUMBER
  ["131026", Disposition.PERMANENT_NUMBER],
  ["131021", Disposition.PERMANENT_NUMBER],
  ["131009", Disposition.PERMANENT_NUMBER], // table's default entry is the phone-param branch
  // PERMANENT_CONFIG
  ["131047", Disposition.PERMANENT_CONFIG],
  ["132001", Disposition.PERMANENT_CONFIG],
  ["132000", Disposition.PERMANENT_CONFIG],
  ["132015", Disposition.PERMANENT_CONFIG],
  ["132016", Disposition.PERMANENT_CONFIG],
  ["132012", Disposition.PERMANENT_CONFIG],
  ["132005", Disposition.PERMANENT_CONFIG],
  ["131031", Disposition.PERMANENT_CONFIG],
  ["131042", Disposition.PERMANENT_CONFIG],
  ["133010", Disposition.PERMANENT_CONFIG],
  ["190", Disposition.PERMANENT_CONFIG],
  ["10", Disposition.PERMANENT_CONFIG],
  // THROTTLED
  ["130429", Disposition.THROTTLED],
  ["131048", Disposition.THROTTLED],
  ["131056", Disposition.THROTTLED],
  ["4", Disposition.THROTTLED],
  ["80007", Disposition.THROTTLED],
  ["133016", Disposition.THROTTLED],
  ["131049", Disposition.THROTTLED],
  // TRANSIENT
  ["131000", Disposition.TRANSIENT],
  ["131016", Disposition.TRANSIENT],
  ["133004", Disposition.TRANSIENT],
  ["131052", Disposition.TRANSIENT],
  ["131053", Disposition.TRANSIENT],
  ["131057", Disposition.TRANSIENT],
];

describe("META_ERROR_CODES seed table", () => {
  it.each(EXPECTED)("code %s classifies to %s", (code, disposition) => {
    const entry = META_ERROR_CODES[code];
    expect(entry).toBeDefined();
    expect(entry!.disposition).toBe(disposition);
  });

  it("every entry has a non-empty layman message and operator hint", () => {
    for (const entry of Object.values(META_ERROR_CODES)) {
      expect(entry.laymanMessage.length).toBeGreaterThan(0);
      expect(entry.operatorHint.length).toBeGreaterThan(0);
    }
  });

  it("PERMANENT_* entries never retry", () => {
    for (const entry of Object.values(META_ERROR_CODES)) {
      if (entry.disposition === Disposition.PERMANENT_NUMBER || entry.disposition === Disposition.PERMANENT_CONFIG) {
        expect(entry.retryMax).toBe(0);
      }
    }
  });

  it("TRANSIENT/THROTTLED entries retry at least once", () => {
    for (const entry of Object.values(META_ERROR_CODES)) {
      if (entry.disposition === Disposition.TRANSIENT || entry.disposition === Disposition.THROTTLED) {
        expect(entry.retryMax).toBeGreaterThan(0);
      }
    }
  });

  it("no layman message contains its own numeric Meta error code", () => {
    // Guards spec §4b: "No user-facing string contains a numeric Meta code
    // or raw Meta text." Mentioning the company name "Meta" in plain
    // English (e.g. "restricted by Meta") is fine — the spec's own copy
    // does this; what's forbidden is the developer code/string itself.
    // Checks against the specific code (not a blanket "no digits" rule,
    // since legitimate copy contains numbers unrelated to codes, e.g.
    // "over 24 hours").
    const allEntries = [
      ...Object.values(META_ERROR_CODES),
      CODE_131009_GENERIC_PARAMETER,
      NETWORK_ERROR_ENTRY,
      UNKNOWN_ERROR_ENTRY,
      PERMISSION_DENIED_RANGE.entry,
    ];
    for (const entry of allEntries) {
      if (/^\d+$/.test(entry.code)) {
        expect(entry.laymanMessage).not.toContain(entry.code);
      }
    }
  });

  it("131009 generic-parameter variant is PERMANENT_CONFIG, not PERMANENT_NUMBER", () => {
    expect(CODE_131009_GENERIC_PARAMETER.disposition).toBe(Disposition.PERMANENT_CONFIG);
  });

  it("131049 is THROTTLED in the table (regression guard companion)", () => {
    expect(META_ERROR_CODES["131049"]!.disposition).toBe(Disposition.THROTTLED);
  });

  it("permission-denied range covers 200-299 as a range, not individual entries", () => {
    expect(PERMISSION_DENIED_RANGE.min).toBe(200);
    expect(PERMISSION_DENIED_RANGE.max).toBe(299);
    expect(PERMISSION_DENIED_RANGE.entry.disposition).toBe(Disposition.PERMANENT_CONFIG);
    // Not individually enumerated in the main table.
    for (let code = 200; code <= 299; code++) {
      expect(META_ERROR_CODES[String(code)]).toBeUndefined();
    }
  });

  it("unknown-code entry is TRANSIENT with a low retry cap of 2", () => {
    expect(UNKNOWN_ERROR_ENTRY.disposition).toBe(Disposition.TRANSIENT);
    expect(UNKNOWN_ERROR_ENTRY.retryMax).toBe(2);
  });

  it("network entry is TRANSIENT", () => {
    expect(NETWORK_ERROR_ENTRY.disposition).toBe(Disposition.TRANSIENT);
  });
});
