# DATABASE_DECISION — D1 vs Neon/Postgres

**Status: DECIDED — D1**, by the product owner on 2026-09-19, without the benchmark. Business modules stay behind `DatabaseProvider`, so this is reversible.

Credit-ledger / reservation-settlement code remains BLOCKED — by `META_COMMERCIAL_BILLING_MODEL.md`, which is a separate gate this decision does not touch.

## What this decision does and does not settle

It settles the store for everything built so far, and that part is genuinely low-risk: the four hard-fail criteria below are all about the **credit wallet**, and no wallet code exists. D1's lack of interactive transactions was designed around from the start — every repository uses `batch()`, and `scripts/check-architecture.mjs` rule 2b fails the build on a `.transaction(` call. So the messaging and CRM workload needs no rework.

It does NOT settle the wallet. When credits are built, the reserve→settle two-phase debit on a hot row is exactly the case SQLite's isolation model is weakest at, and the four criteria below still have to be demonstrated before that code ships. Choosing D1 now is not a finding that D1 passes them.

## The one place the adapter model does NOT absorb the choice

Swapping a `DatabaseProvider` handles SQL dialect. It does not conjure missing engine features, and the AI knowledge base (`supabase/migrations/030_ai_knowledge.sql`) depends on two Postgres features SQLite has no equivalent for:

- **`pgvector`** — 1536-dim embeddings with vector similarity search. D1 has no vector type. On Cloudflare this means **Vectorize**, a separate service with its own API — a new provider interface, not a `DatabaseProvider` implementation, and embeddings stop living next to the rows they describe (no joining a similarity search to a tenant-scoped table in one query).
- **`tsvector` full-text search** — D1/SQLite offers FTS5 instead: different DDL, different query syntax, different ranking. The semantic and lexical halves of that feature both need rewriting, not porting.

Nothing else built so far touches either. Treat the AI knowledge base as its own migration project with a real design decision in it, and do not assume it comes along with the rest.

## Revisit triggers
- Approaching D1's 10 GB per-database ceiling (the large-tenant scenario below assumes 10M+ messages — size that against the ceiling before it arrives, not after).
- Any of the four wallet correctness criteria failing when credits are built.
- Sustained write throughput or p95 latency past whatever thresholds the eventual benchmark sets.

## Why this gate
The critical workload is not plain CRUD. One inbound WhatsApp message → message insert + conversation update + unread update + event + notification + multi-client reads. Broadcast fan-out (already 3,142 recipient rows from 17 broadcasts in prod — see MIGRATION_MAP) is the real write burst. Credits add **two-phase reserve→settle** under webhook/worker retries — the hardest concurrency case.

## Benchmark workload (build a repeatable harness)
- Concurrent WhatsApp sends
- Concurrent credit **reservations** on one wallet
- Retries (same idempotency key) + duplicate webhook/provider events
- `settle` and `release/expire` under contention
- Concurrent wallet updates (hot-row)
- Broadcast burst (N recipients) + inbound burst
- Large tenant: 1 account, 10M+ messages — listing, history pagination, unread counts, search, index effectiveness
- Multi-tenant: hot-partition / noisy-neighbor

Measure p50/p95/p99 write latency, error rate, queue backlog, transaction latency, cost, operational complexity.

## Acceptance — correctness first (hard fail)
```
No negative balance
No double debit
No duplicate settlement
No lost reservation
```
If D1 cannot reliably guarantee these under realistic concurrency → **use Neon/Postgres.** Performance/cost are secondary to these four.

## D1-specific risks to probe
- SQLite transaction isolation vs Postgres for the reserve/settle two-phase debit.
- Per-DB size + write-concurrency ceiling at 10M+ messages / broadcast bursts.
- Session/read-consistency after write (immediate read-your-write on the inbox).

## Deliverable — record in this file
Workload assumptions · methodology · D1 results · Neon results · cost model · operational model · consistency model · scaling risks · **decision** · revisit triggers (thresholds from measurement, e.g. revisit if sustained writes > X, p95 > Y, DB size > Z, queue backlog > N).

## Contract tests (both adapters)
`ConversationRepositoryContractTests` + `WalletRepositoryContractTests` run against **both** D1 and Postgres adapters: create/get/list/paginate/update, **concurrent update, reserve/settle/release idempotency, tenant isolation, transaction behaviour.** This proves the escape hatch is real, not theoretical.
