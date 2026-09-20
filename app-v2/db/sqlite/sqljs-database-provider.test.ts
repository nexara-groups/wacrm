import { describe, expect, it } from "vitest";
import { toSqlitePlaceholders } from "./sqljs-database-provider";

describe("toSqlitePlaceholders — regions that must not be rewritten", () => {
  it("ignores $n inside a line comment", () => {
    // The bug this exists for: an explanatory comment quoting "where id = $1"
    // added a second `?` and a second bound parameter, while SQLite ignored
    // the comment and saw one placeholder. `bind` then failed with "column
    // index out of range" — from a comment.
    const { sql, params } = toSqlitePlaceholders(
      `-- the tenant predicate is "where id = $1"\n select * from t where id = $1`,
      ["acct-a"],
    );
    expect(params).toEqual(["acct-a"]);
    expect(sql.match(/\?/g)).toHaveLength(1);
    expect(sql).toContain("$1"); // untouched inside the comment
  });

  it("ignores $n inside a block comment", () => {
    const { params } = toSqlitePlaceholders(
      `/* see $1 and $2 */ select * from t where id = $1`,
      ["acct-a"],
    );
    expect(params).toEqual(["acct-a"]);
  });

  it("ignores $n inside a string literal", () => {
    const { sql, params } = toSqlitePlaceholders(
      `select * from t where label = 'costs $1 per seat' and id = $1`,
      ["acct-a"],
    );
    expect(params).toEqual(["acct-a"]);
    expect(sql).toContain("'costs $1 per seat'");
  });

  it("still rewrites real placeholders, in order of appearance", () => {
    const { sql, params } = toSqlitePlaceholders(
      `update t set a = $2 where id = $1`,
      ["acct-a", 180],
    );
    expect(sql).toBe("update t set a = ? where id = ?");
    expect(params).toEqual([180, "acct-a"]);
  });
});
