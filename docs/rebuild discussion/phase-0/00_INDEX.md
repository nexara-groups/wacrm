# Nexara WACRM — Phase 0 Gate Docs (index)

Final plan split across files. v6 (`../Nexara_WACRM_Rebuild_Architecture_v6_decisions.md`) is the decision record; these are the Phase-0 execution outputs and design specs it required.

| Doc | Purpose | Status |
|---|---|---|
| [MIGRATION_MAP.md](MIGRATION_MAP.md) | Phase 0A — real production counts + cutover decision | **DONE (evidence)** |
| [META_COMMERCIAL_BILLING_MODEL.md](META_COMMERCIAL_BILLING_MODEL.md) | Phase 0B — Meta eligibility research + model choice | **DONE (research); commercial confirmation pending Meta** |
| [ARCHITECTURE_MODEL.md](ARCHITECTURE_MODEL.md) | Final layered architecture + module/provider map | DONE |
| [NEW_REPO_PLAN.md](NEW_REPO_PLAN.md) | Merge framework + wacrm into new canonical repo | DONE (plan) |
| [AUTH_EXTENSION.md](AUTH_EXTENSION.md) | Extended `AuthProvider` contract + tables | DONE (spec) |
| [DATABASE_DECISION.md](DATABASE_DECISION.md) | D1 vs Neon benchmark methodology + acceptance | **PENDING benchmark run** |
| [CREDITS_BILLING_DESIGN.md](CREDITS_BILLING_DESIGN.md) | Credits/ledger/reservation design (NO code yet) | DONE (design); build gated |
| [META_ONBOARDING_FLOW.md](META_ONBOARDING_FLOW.md) | Embedded Signup wizard + state machine | DONE (spec) |
| [DO_NOT_BUILD_YET.md](DO_NOT_BUILD_YET.md) | Explicit deferred list + build gates | DONE |
| [SUPABASE_EXIT_PLAN.md](SUPABASE_EXIT_PLAN.md) | Full Supabase removal — verified surface + Nexara replacement map + sequence | DONE |
| [META_ERROR_TAXONOMY.md](META_ERROR_TAXONOMY.md) | Meta error classification, plain-English messages, number suppression | DONE (design); codes to verify vs live Meta docs |
| [SUPER_ADMIN_CONSOLE.md](SUPER_ADMIN_CONSOLE.md) | Platform operator console — cross-tenant visibility + platform principal | DONE (design) |
| [PLAN_REVIEW_DELTA.md](PLAN_REVIEW_DELTA.md) | Review of the plan against the three new inputs; required changes | DONE |

## Two hard gates before any credit-ledger / settlement code
1. **Meta commercial gate** — Solution Partner + credit-line eligibility (see META_COMMERCIAL_BILLING_MODEL). Until confirmed, build the **Tech-Provider fallback** billing model.
2. **DB correctness benchmark** — D1 vs Neon under concurrent reserve/settle (see DATABASE_DECISION). Until passed, do not lock the DB.

## Third blocker (new)
**Confirm the production `SUPABASE_URL`** before cutover planning proceeds. `MIGRATION_MAP.md` flags that `.env.local` may point at dev, not the live Worker's dashboard-managed DB. Under a full exit + one-time cutover, migrating the wrong database silently loses real data at switchover. This was a caveat; it is now blocking.

## Headline recommendation
Build V1 on the **Tech Provider fallback model** (customer WABA billed by Meta directly; Nexara Credits are prepaid access-control + service margin). Pursue Solution Partner in parallel as a business track. Billing layer stays swappable — messaging architecture identical in both. Migration = **one-time cutover** (production footprint is negligible, evidence in MIGRATION_MAP).
