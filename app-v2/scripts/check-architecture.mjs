#!/usr/bin/env node
/**
 * Architecture guard — enforces the dependency rules.
 *
 * 1. Business logic (everything under src/ EXCEPT the allow-listed composition
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
const SRC = join(ROOT, "src");

// Files/dirs permitted to import provider SDKs (the only seams that may).
const ALLOWLIST = [
  "src/core/platform/providers",
  "src/core/database/providers",
  "src/core/auth/providers",
  "src/core/container.ts",
  "src/app/_services.ts",
];

const FORBIDDEN = [
  { pattern: /from\s+["']@supabase\//, label: "@supabase/* SDK" },
  { pattern: /from\s+["']@opennextjs\/cloudflare["']/, label: "@opennextjs/cloudflare runtime" },
];

const FEATURE_DIR = "src/features";

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

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  const norm = rel.split(sep).join("/");
  const text = readFileSync(file, "utf8");

  // Rule 1 — no provider SDK leakage outside the allow-listed seams.
  if (!isAllowlisted(rel)) {
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(text)) violations.push(`  x ${norm} imports ${label}`);
    }
  }

  // Rule 2 — service layers contain no SQL and no DB-layer access. Applies to
  // src/features/** and any module's application/ layer.
  const isServiceLayer =
    norm.startsWith(FEATURE_DIR + "/") || /^src\/modules\/[^/]+\/application\//.test(norm);
  if (isServiceLayer) {
    if (/from\s+["'][^"']*core\/database/.test(text)) {
      violations.push(`  x ${norm} imports the database layer (use a repository)`);
    }
    if (/\.query\s*[<(]/.test(text)) {
      violations.push(`  x ${norm} executes SQL via .query() (move it to a repository)`);
    }
  }

  // Rule 3 — tenant safety: SQL in infrastructure must filter by tenant_id.
  if (norm.includes("/infrastructure/")) {
    for (const block of text.match(/`[^`]*`/g) ?? []) {
      const sql = block.toLowerCase();
      const looksLikeSql =
        /\b(select|insert\s+into|update|delete)\b/.test(sql) && /\b(from|into|set)\b/.test(sql);
      if (looksLikeSql && !sql.includes("tenant_id") && !sql.includes("no-tenant")) {
        violations.push(`  x ${norm} has a SQL statement with no tenant_id filter`);
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
