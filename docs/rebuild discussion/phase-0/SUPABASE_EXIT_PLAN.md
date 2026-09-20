# SUPABASE_EXIT_PLAN — Full Supabase Removal

**Driver:** cost. Decision is to leave Supabase in **all** aspects, not just the database.

This doc does three things: (1) verifies what the current app actually uses Supabase for, measured not assumed; (2) maps each surface to its Nexara-framework replacement, verified against `nexara-repo-framework@main`; (3) sequences the exit.

Read with `ARCHITECTURE_MODEL.md` (layers/providers) and `DATABASE_DECISION.md` (the DB gate this does **not** pre-empt).

---

## 1. Verified Supabase surface (measured against `wacrm@main`)

Supabase is not "the database" here. Postgres is roughly a fifth of what the app leans on.

| Surface | Measured usage | Evidence |
|---|---|---|
| **PostgREST** (query layer) | **509** `.from()` calls across **167** files; 65 API routes; **15** `.rpc()` call sites | `grep -rn "\.from(" src` |
| **Postgres** (data) | 41 tables · 37 functions · 19 triggers · extensions `uuid-ossp`, `vector` | `supabase/migrations/*.sql` |
| **Auth (GoTrue)** | 58 `auth.*` calls (`getUser` ×36, `getSession` ×11, `signInWithPassword`, `signUp`, `signOut`, `updateUser`, `resetPasswordForEmail`, `admin.createUser` ×2) | `src/**`, `src/lib/supabase/*` |
| **RLS** | **163 policies**; **96** `auth.uid()` references; **40** `auth.users` references | 20 of 40 migrations declare policies |
| **Realtime** | 6 `postgres_changes` channels — message thread, inbox, presence, total-unread, notifications page, notification count | `src/hooks/use-*.ts`, `src/components/inbox/message-thread.tsx` |
| **Storage** | 3 buckets (profile avatars, chat media, flow media); 4 `.storage.from()` call sites; bucket policies on `storage.objects` | migrations 008, 016, 023 |
| **pgvector** | AI knowledge base semantic search, 1536-dim OpenAI embeddings, with a lexical `tsvector` fallback | migration 030 |
| **service_role** | 3 admin clients bypassing RLS (ai, flows, automations) | `src/lib/*/admin-client.ts` |

**The load-bearing fact:** RLS *is* the multi-tenancy model. 163 policies keyed on `auth.uid()` are the only thing preventing cross-tenant reads today. Removing Supabase Auth removes `auth.uid()`, which invalidates every one of those policies simultaneously. Auth and authorization must be replaced together, never incrementally.

---

## 2. Replacement map — verified against the framework

Checked `nexara-repo-framework/src/core/*`. Status is what the framework *actually ships today*, not what the architecture doc aspires to.

| Supabase surface | Nexara replacement | Framework status | Work |
|---|---|---|---|
| Postgres / PostgREST | `DatabaseProvider` + repository layer | ✅ `d1-database-provider.ts`, `supabase-database-provider.ts` | **USE** interface; **BUILD** the chosen adapter (per DB gate). Delete the Supabase adapter. |
| Auth (GoTrue) | `AuthProvider` → `JwtAuthProvider` (jose) | ✅ `jwt-auth-provider.ts` + `credentials-auth-provider.interface.ts` + `db/migrations/d1/0002_credentials.sql` | **ADAPT/EXTEND** per `AUTH_EXTENSION.md` (refresh rotation, reset, verify, devices). Delete `supabase-auth-provider.ts`. |
| RLS (163 policies) | `PermissionService` + `TenantContext` + guard-enforced `account_id` filter on every infra SQL statement | ✅ `src/core/rbac/*`, `src/core/context/tenant-context.ts`, `scripts/check-architecture.mjs` | **PORT** — authorization moves from DB to application layer. Highest-risk item in this plan; see §4. |
| Storage (3 buckets) | `StorageProvider` → R2 | ✅ `r2-storage-provider.ts` | **USE**. Signed direct upload. Re-home bucket policies as application checks. |
| Realtime (6 channels) | `RealtimeProvider` — V1 = polling + push + incremental sync | ❌ **not in framework** | **BUILD** the interface. v6 defers WebSocket/DO until UX proves need. |
| pgvector | `VectorProvider` → Vectorize | ❌ **not in framework** | **BUILD**. Or keep pgvector if the DB gate lands on Postgres — decide *after* the gate. |
| Transactional email (auth flows) | `EmailProvider` | ✅ brevo · resend · **ses** · console · allowlist · unavailable | **USE**. Supabase sent auth email implicitly; this becomes explicit and must be wired before auth cutover. |
| `service_role` admin clients | Server-side container wiring + explicit permission checks | ✅ container pattern | **PORT** — no ambient RLS bypass; each admin path states its authority. |
| Runtime / KV / Queues | `PlatformProvider` | ✅ `cloudflare-platform-provider.ts` | **USE** (already the deploy target). |

### Gaps this exposes

Three providers the architecture doc lists as if they exist do not exist in the framework yet: **`RealtimeProvider`**, **`VectorProvider`**, **`NotificationProvider`**, plus **`PaymentProvider`**, **`WhatsAppProvider`**, **`MetaBusinessProvider`** and **`UsageMeter`**. `ARCHITECTURE_MODEL.md` §4 lists all of them in one table without distinguishing shipped from unbuilt. That table should be annotated — see `PLAN_REVIEW_DELTA.md` §1.

**The framework itself ships Supabase adapters.** `supabase-database-provider.ts` and `supabase-auth-provider.ts` must be deleted from the new canonical repo, not merely left unwired — otherwise "we left Supabase" stays true only by configuration, and `@supabase/*` stays in the dependency tree.

---

## 3. What actually saves money

Worth being precise, because the cost driver should survive contact with the bill.

| Cost today | After exit |
|---|---|
| Supabase Pro ~$25/mo + usage (per project; separate dev/staging/prod multiplies it) | Workers Paid ~$5/mo covers runtime + KV + Queues + Cron |
| Storage billed per Supabase pricing | R2 $0.015/GB-mo, **$0 egress** |
| Auth/Realtime/Storage bundled — no line-item control | each priced separately and independently scalable |
| DB cost fixed to plan tier | per `COST_D1_vs_AWS.md`: D1 ~$5/$24/$276 · Neon ~$20-40/$80-150/$300-600 at Small/Medium/Large |

Honest caveat: at **3 accounts, 3 users, 349 contacts, 66 messages** (`MIGRATION_MAP.md`), current Supabase spend is near its floor. The saving is real but small *today* — the case is structural (no bundled floor, per-service scaling, no vendor concentration), and it grows with scale. Worth stating plainly rather than overselling a $20/mo win.

---

## 4. The one genuinely dangerous step

**RLS → application-layer authorization.** Everything else on this list is a provider swap behind an interface. This one deletes a database-enforced safety net and replaces it with discipline.

Mitigations, all already available:
1. `check-architecture.mjs` **already enforces** `tenant_id` on every infrastructure SQL statement, and blocks CI. Re-point its allow-list per `NEW_REPO_PLAN.md` §4 and treat a guard failure as a release blocker.
2. `TenantContext` resolves scope once at the edge; repositories take it as a required argument, never optional.
3. Contract tests must include **tenant isolation** cases per adapter — `DATABASE_DECISION.md` already requires this for the wallet/conversation repositories. Extend to every repository.
4. Port the 163 policies as a **checklist**, not from memory: each policy maps to either an application check or an explicit "not needed because…". Record the mapping; do not hand-wave it.

If the DB gate lands on Postgres, RLS remains available as defence-in-depth using `SET LOCAL` + session claims. That is a genuine argument for Postgres over D1 that the gate should weigh — it is not currently listed in `DATABASE_DECISION.md`.

---

## 5. Sequence

Ordering is driven by dependency, not convenience. Auth and RLS are one step.

| # | Step | Depends on | Blocks |
|---|---|---|---|
| 0 | **Close the DB gate** (`DATABASE_DECISION.md`) | — | everything below |
| 1 | New canonical repo per `NEW_REPO_PLAN.md`; delete both Supabase adapters | 0 | all |
| 2 | Wire `EmailProvider` (SES or Brevo) | 1 | 3 |
| 3 | **Auth + authorization together** — `JwtAuthProvider` extended, `PermissionService`, `TenantContext`, 163-policy checklist | 1, 2 | 4-7 |
| 4 | Schema + forward-only migrations on the chosen DB; repositories with guard-enforced tenant scope | 0, 1 | 5-7 |
| 5 | `StorageProvider` → R2; re-home the 3 buckets | 1, 3 | — |
| 6 | `RealtimeProvider` (polling + push + incremental sync) replacing 6 channels | 3, 4 | — |
| 7 | `VectorProvider` (Vectorize) or pgvector-on-chosen-DB | 0, 4 | — |
| 8 | **One-time cutover** per `MIGRATION_MAP.md` — export, transform, import, verify, switch DNS; keep old deploy warm | 3-7 | — |

Data volume is negligible, so step 8 is an evening, not a project. The work is steps 3 and 4.

---

## 6. Acceptance

Exit is complete when all of these hold:

```
grep -r "@supabase" package.json src/   →  no matches
No SUPABASE_* variable in any environment
Architecture guard green in CI
Tenant-isolation contract tests green on the chosen adapter
All 163 legacy policies accounted for in the port checklist
First vertical slice (ARCHITECTURE_MODEL §5) passes end to end
Old Supabase project still running but receiving zero traffic for 7 days
```

Only then delete the Supabase project. Reversibility until proven, per v6.
