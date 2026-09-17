# PLAN_REVIEW_DELTA — Changes Required to the Rebuild Plan

Review of the existing plan (v5 architecture, v6 decisions, Phase-0 docs) against three new inputs: **full Supabase exit on cost grounds**, **Meta error handling + number suppression**, **platform super-admin console**.

Verdict: the plan's **architecture is sound and needs no structural change.** The adapter model already absorbs the Supabase exit — that is exactly what it was built for. Nine changes are required, of which three are substantive and six are corrections or additions.

---

## Substantive changes

### 1. The Supabase exit removes a DB-gate option — and adds a criterion

`DATABASE_DECISION.md` frames the choice as D1 vs Neon/Postgres on correctness and cost. Two updates:

- **`supabase-database-provider.ts` is now dead.** The framework ships it; it must be deleted from the canonical repo, not merely left unwired (`SUPABASE_EXIT_PLAN.md` §2).
- **Add a gate criterion: RLS as defence-in-depth.** The exit moves 163 RLS policies from database enforcement to application enforcement — the single highest-risk step in the whole migration. A Postgres target keeps RLS available as a second layer via `SET LOCAL` + session claims; D1 (SQLite) does not. This is a genuine correctness argument for Postgres that the current gate criteria do not capture. It does not override the four hard invariants, but it belongs in the decision record.

The gate itself remains **PENDING** and still blocks ledger/settlement code. Nothing here pre-empts it.

### 2. Platform-admin is a second principal dimension — decide now, not later

`ARCHITECTURE_MODEL.md` §2 lists "platform-admin" as a concern of the `organizations` module. That placement is wrong: it implies a tenant-scoped role. The framework's `ROLES` are all tenant-scoped, and adding a fifth would make platform access reachable through the normal membership path.

`SUPER_ADMIN_CONSOLE.md` §2 specifies an orthogonal `platformRole` on `Principal` instead. **This must land with the RBAC foundation**, before authorization call sites multiply. The console can wait; the principal model cannot.

### 3. Meta error handling is missing from the plan entirely

Neither v5, v6, nor any Phase-0 doc addresses Meta error classification, retry policy, or number suppression. Verified against the current code, this is a real production gap: raw Meta strings are shown to users, and failed numbers are retried forever (`META_ERROR_TAXONOMY.md` §1).

It is also a **billing correctness** issue, which makes it a v6 concern rather than a polish item. Without a pre-send suppression guard, a number that can never receive messages consumes a credit reservation on every broadcast. Add the suppression check as an explicit precondition to reservation in `CREDITS_BILLING_DESIGN.md`.

---

## Corrections and additions

### 4. `ARCHITECTURE_MODEL.md` §4 overstates what the framework ships

The provider table lists nine providers uniformly, implying they exist. Verified against `nexara-repo-framework@main`:

| Ships today | Does **not** exist yet |
|---|---|
| `DatabaseProvider` (D1, Supabase) · `AuthProvider` (JWT, Supabase) · `StorageProvider` (R2) · `PlatformProvider` (Cloudflare) · `EmailProvider` (SES/Brevo/Resend/console) · `PermissionService` · `EventBus` · `RequestContext`/`TenantContext` | `RealtimeProvider` · `VectorProvider` · `NotificationProvider` · `PaymentProvider` · `WhatsAppProvider` · `MetaBusinessProvider` · `UsageMeter` |

Annotate the table with USE vs BUILD per the v6 complexity gate. Seven of nine are BUILD — material to sequencing and estimation.

### 5. `EmailProvider` is an unlisted dependency of auth cutover

Supabase Auth sent password-reset, verification, and invitation email implicitly. `AUTH_EXTENSION.md` specifies all three flows but never mentions email delivery. The framework ships `EmailProvider` (SES, Brevo, Resend) — it just has to be wired **before** auth cutover, or those flows ship broken. Add to `AUTH_EXTENSION.md` as an explicit prerequisite.

### 6. Storage and realtime were never scoped

The Supabase surface audit found 3 storage buckets with `storage.objects` policies, and 6 realtime `postgres_changes` channels. `ARCHITECTURE_MODEL.md` §6 says "Realtime V1 = polling + push + incremental sync" but no doc enumerates what must be replaced. `SUPABASE_EXIT_PLAN.md` §1 now has the inventory — reference it from the migration plan.

### 7. `MIGRATION_MAP.md` has an open caveat that is now load-bearing

The doc flags that `.env.local` may point at dev, not production, and that the live Worker's `SUPABASE_URL` is dashboard-managed. With a **full exit and one-time cutover**, migrating from the wrong database means silently losing real customer data at switchover.

**Action: confirm the production `SUPABASE_URL` before cutover planning proceeds.** This was a caveat; it is now a blocker on step 8 of the exit sequence.

### 8. The console is a first-class consumer of the reporting rollups

`reporting/TRD.md` scopes rollups for tenant-facing reporting. The fleet overview and delivery-health surfaces need the same aggregates cross-tenant. On D1, rows-scanned billing makes naive cross-tenant scans a cost incident (`COST_D1_vs_AWS.md`). Add the console as a named consumer so `account_rollup_daily` is designed once, for both.

### 9. `DO_NOT_BUILD_YET.md` needs the new items classified

| Item | Classification |
|---|---|
| `MetaErrorClassifier` + code table + suppression state machine | **BUILD now** — pure domain, no gate dependency |
| Suppression → credit-reservation guard | **GATED** — touches reservation code, both hard gates |
| `Principal.platformRole` + `platform_audit_log` | **BUILD now** — expensive to retrofit |
| Platform console UI (fleet, activity, health) | **DEFER** — after the vertical slice |
| Impersonation | **DEFER** — last; needs audit + consent machinery proven |

---

## What does not change

Worth stating explicitly, since the temptation with three new requirements is to reopen settled decisions:

- **Layered adapter architecture** — absorbs the Supabase exit with no structural change. Vindicated, not challenged.
- **One-time cutover** — 3 accounts / 349 contacts / 66 messages. Full exit does not change the volume.
- **Tech-Provider fallback billing model** as the V1 build target.
- **Both hard gates** — Meta commercial and DB correctness — still block ledger/settlement code.
- **First vertical slice** as the acceptance test. The console and the error taxonomy are additive; neither belongs inside the slice.
- **Deferred list** — Work Hub, Calendar, Approvals, mobile Action Center, postpaid billing all stay deferred.

---

## Updated Phase-0 status

| Doc | Status |
|---|---|
| MIGRATION_MAP.md | DONE — ⚠ **production-URL confirmation now blocking** |
| META_COMMERCIAL_BILLING_MODEL.md | DONE (research); commercial confirmation pending Meta |
| ARCHITECTURE_MODEL.md | DONE — needs §4 USE/BUILD annotation (§4 above) |
| NEW_REPO_PLAN.md | DONE — add "delete Supabase adapters" to merge steps |
| AUTH_EXTENSION.md | DONE — add `EmailProvider` prerequisite (§5 above) |
| DATABASE_DECISION.md | **PENDING benchmark** — add RLS defence-in-depth criterion (§1 above) |
| CREDITS_BILLING_DESIGN.md | DONE — add suppression precondition to reservation (§3 above) |
| META_ONBOARDING_FLOW.md | DONE |
| DO_NOT_BUILD_YET.md | DONE — add new classifications (§9 above) |
| **SUPABASE_EXIT_PLAN.md** | **NEW** — DONE |
| **META_ERROR_TAXONOMY.md** | **NEW** — DONE (design); codes to verify against live Meta docs |
| **SUPER_ADMIN_CONSOLE.md** | **NEW** — DONE (design) |

## Immediate actions, in order

1. **Confirm production `SUPABASE_URL`** — blocks cutover planning (§7).
2. **Run the DB benchmark** — still the critical path; blocks the DB lock and all ledger code.
3. **Verify the Meta error codes** in `META_ERROR_TAXONOMY.md` §3 against live Meta documentation.
4. Apply the six documentation corrections above to the existing Phase-0 docs.
