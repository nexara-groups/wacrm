# PLAN_REVIEW_DELTA — Changes Required to the Rebuild Plan

Review of the existing plan (v5 architecture, v6 decisions, Phase-0 docs) against the new inputs: **full Supabase exit on cost grounds**, **Meta error handling + opt-out suppression**, **platform super-admin console with Meta compliance evidence**, **per-account sub-user seat caps**.

Verdict: the plan's **architecture is sound and needs no structural change.** The adapter model already absorbs the Supabase exit — that is exactly what it was built for. Twelve changes are required, of which six are substantive and six are corrections or additions.

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

### 3b. Opt-out / DND is a separate suppression axis from delivery failure

`META_ERROR_TAXONOMY.md` §3b. A person who replies STOP produces **no Meta error** — the message delivers fine. But re-sending is a compliance breach and it degrades the WABA quality rating, which throttles the whole account.

So `consent_state` is modelled separately from `deliverability_state`. The rule that matters: **an operator may clear a technical suppression but never an opt-out.** Only the person can reverse their own opt-out. Sharing one "clear suppression" button between the two is how a regulator-facing incident happens. Opt-out is also per-account (opting out of one client is not opting out of another) and must survive CSV re-import.

### 3c. Platform staff must never be able to browse customer messages

Revised from the first draft of `SUPER_ADMIN_CONSOLE.md`. "Message content access with justification" was still a standing capability. It is now removed at **every** tier including `platform_superadmin`, and replaced by **compliance cases** (§7 of that doc): scope declared up front, two-person approval, TTL, every read logged to the case, tenant notified.

This is what makes Meta queries answerable without Nexara holding permanent read access to every customer's conversations. Between cases the capability does not exist in an idle state. Aggregate metadata — which answers most Meta questions by itself — needs no case.

### 3d. Seat caps do not exist and must land with the organizations module

`SEAT_LIMITS.md`. Verified: `profiles.account_id` + `account_invitations` with **no cap column, check, or enforcement anywhere**. Accounts can invite unbounded members today.

The cap resolves `account.seat_limit_override ?? plan.included_seats ?? platform default`, so a plan change lifts every account on it while single accounts keep an audited exception path. Two decisions that prevent support tickets: **pending invitations count** (else the cap is decorative), and **downgrade never auto-removes members** (grandfather into `over_seat_limit`, block growth until usage drops).

Concurrent invitation acceptance at the cap boundary is the same hot-row concurrency class as the credit wallet — it belongs in the DB benchmark's contract tests.

Also flagged: the current role vocabulary (`owner`/`admin`/`agent`/`viewer`) differs from the framework's (`owner`/`admin`/`manager`/`member`). The organizations port must reconcile them rather than carry both.

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
| Opt-out / `consent_state` + stop-keyword handling | **BUILD now** — compliance, no gate dependency |
| Seat cap: `resolved_seat_limit` + `SeatService` + invite/accept enforcement | **BUILD now** — with the organizations module |
| Compliance cases (Meta query evidence) | **BUILD by Meta go-live** — needed the first query |
| Purchasable extra seats / overage charging | **GATED** — with billing |
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
| **SEAT_LIMITS.md** | **NEW** — DONE (design) |

## Immediate actions, in order

1. **Confirm production `SUPABASE_URL`** — blocks cutover planning (§7).
2. **Run the DB benchmark** — still the critical path; blocks the DB lock and all ledger code.
3. **Verify the Meta error codes** in `META_ERROR_TAXONOMY.md` §3 against live Meta documentation.
4. Apply the six documentation corrections above to the existing Phase-0 docs.
