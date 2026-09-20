#!/usr/bin/env node
/**
 * Architecture guard — enforces the dependency rules.
 *
 * 1. Business logic (everything under nexara/, modules/ and packages/ EXCEPT the allow-listed composition
 *    points) must never import a provider SDK directly:
 *      - @supabase/*            (database / auth providers only)
 *      - @opennextjs/cloudflare (runtime adapter / container only)
 * 2. Application/feature services must not contain SQL or touch the database
 *    layer — they go through repositories.
 * 3. Tenant safety: every SQL statement in an infrastructure repository must
 *    filter by `tenant_id` (escape hatch: a `no-tenant` comment in the SQL).
 *
 * Run: `node scripts/check-architecture.mjs`  (also wired into `npm run verify`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SCAN_ROOTS = ["nexara", "modules", "packages"].map((d) => join(ROOT, d));

// Files/dirs permitted to import provider SDKs (the only seams that may).
const ALLOWLIST = [
  "nexara/core/platform/providers",
  "nexara/core/database/providers",
  "nexara/core/auth/providers",
  "nexara/core/container.ts",
  "nexara/core/email/providers",
];

const FORBIDDEN = [
  { pattern: /from\s+["']@supabase\//, label: "@supabase/* SDK" },
  { pattern: /from\s+["']@opennextjs\/cloudflare["']/, label: "@opennextjs/cloudflare runtime" },
];

const FEATURE_DIR = "modules";

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function isAllowlisted(relPath) {
  const norm = relPath.split(sep).join("/");
  return ALLOWLIST.some((a) => norm === a || norm.startsWith(a + "/"));
}

const violations = [];

for (const file of SCAN_ROOTS.flatMap((root) => [...walk(root)])) {
  const rel = relative(ROOT, file);
  const norm = rel.split(sep).join("/");
  const text = readFileSync(file, "utf8");

  // Rule 1 — no provider SDK leakage outside the allow-listed seams.
  if (!isAllowlisted(rel)) {
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(text)) violations.push(`  x ${norm} imports ${label}`);
    }
  }

  // Rule 2 — service layers contain no SQL and no DB-layer access. This is the
  // application/presentation layer ONLY: a module's infrastructure/ layer is
  // exactly where SQL belongs, so it must not be caught here.
  const isServiceLayer = new RegExp(
    `^${FEATURE_DIR}/[^/]+/(application|presentation|domain)/`,
  ).test(norm);
  if (isServiceLayer) {
    if (/from\s+["'][^"']*core\/database/.test(text)) {
      violations.push(`  x ${norm} imports the database layer (use a repository)`);
    }
    if (/\.query\s*[<(]/.test(text)) {
      violations.push(`  x ${norm} executes SQL via .query() (move it to a repository)`);
    }
  }

  // Rule 2b — no interactive transactions in a module's infrastructure.
  //
  // `D1DatabaseProvider.transaction()` throws unconditionally: D1 has no
  // interactive transactions. A repository written on `transaction()`
  // therefore compiles, passes every sql.js-backed test, and then throws on
  // the production target — a false green that only shows up in production.
  // The operational store is still undecided (DATABASE_DECISION.md), so
  // repositories may use only capabilities BOTH candidates support.
  // `batch()` is atomic on D1, Postgres and sql.js alike.
  if (/^modules\/[^/]+\/infrastructure\//.test(norm) && !norm.endsWith(".test.ts")) {
    if (/\.transaction\s*\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " "))) {
      violations.push(
        `  x ${norm} uses .transaction() — D1 has none; use .batch() for atomic multi-statement writes`,
      );
    }
  }

  // Rule 3 — tenant safety: every SQL statement in an infrastructure layer must
  // scope to the tenant column. This codebase's tenant column is `account_id`
  // (see 0001_identity.sql); `tenant_id` is accepted for framework-level tables
  // that predate it.
  //
  // SQL comments are STRIPPED before the check. Without that, a statement can
  // satisfy this rule with a comment mentioning the column while filtering on
  // nothing — which is precisely what happened before this was tightened, and
  // it made the rule vacuous. Since the Supabase exit moves 163 RLS policies
  // from the database into application code, this guard is the mitigation;
  // it has to actually check.
  //
  // A statement that genuinely cannot carry the column opts out with an
  // explicit `tenant-scope-exempt: <reason>` marker, so every exemption is
  // greppable and reviewable. Two legitimate cases: a deliberate cross-tenant
  // read (platform-admin console, SUPER_ADMIN_CONSOLE.md §4), and a write to
  // a tenant-ROOT table such as `accounts`, whose tenant column is its own id.
  if (norm.includes("/infrastructure/")) {
    for (const block of text.match(/`[^`]*`/g) ?? []) {
      const withoutComments = block
        .replace(/--[^\n]*/g, " ")
        .replace(/\/\*[\s\S]*?\*\//g, " ");
      const sql = withoutComments.toLowerCase();
      const looksLikeSql =
        /\b(select|insert\s+into|update|delete)\b/.test(sql) && /\b(from|into|set)\b/.test(sql);
      const scoped = sql.includes("account_id") || sql.includes("tenant_id");
      const exempt = block.toLowerCase().includes("tenant-scope-exempt:");
      if (looksLikeSql && !scoped && !exempt) {
        violations.push(`  x ${norm} has a SQL statement that is not scoped to account_id`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture check FAILED:");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("Architecture check passed — dependency rules and repository boundary intact.");
