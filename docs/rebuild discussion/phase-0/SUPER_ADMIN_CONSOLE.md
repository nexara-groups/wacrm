# SUPER_ADMIN_CONSOLE — Platform Operator Console

A Nexara-staff-only view across **all** tenant accounts: activity, health, billing, support. Distinct from an account's own `owner` role, which sees one tenant.

---

## 1. What exists today (verified)

Migration `037_platform_admin.sql` is a stub:

```sql
CREATE TABLE platform_admins (user_id UUID PRIMARY KEY REFERENCES auth.users(id), created_at TIMESTAMPTZ);
CREATE FUNCTION is_platform_admin() RETURNS BOOLEAN ...   -- SECURITY DEFINER on auth.uid()
CREATE POLICY platform_admins_select ON platform_admins FOR SELECT USING (is_platform_admin());
```

Per `MIGRATION_MAP.md` this migration is **not applied** to the live project — `platform_admins` returns `PGRST205 (table not in schema)`. So: no console, no cross-tenant queries, and the mechanism depends on `auth.uid()`, which the Supabase exit removes anyway. **Greenfield.**

The framework does not help either: `nexara-repo-framework/src/core/rbac/roles.ts` ships exactly four roles — `owner`/`admin`/`manager`/`member` — all **tenant-scoped**. There is no platform-level principal. This is a **BUILD**, and it needs a change to the framework's RBAC model.

---

## 2. The design decision that matters

A platform admin is **not a fifth role**. Adding `super_admin` to `ROLES` would make it comparable to `owner` via `ROLE_RANK` and reachable through the normal tenant membership path — meaning a bug in invitation or role-assignment code could mint one. The blast radius is every tenant's data.

**Model it as a separate, orthogonal principal dimension:**

```ts
interface Principal {
  userId: UserId;
  tenantRole?: Role;              // owner | admin | manager | member — within one account
  platformRole?: PlatformRole;    // separate axis, separate table, separate grant path
}

const PLATFORM_ROLES = ['platform_support', 'platform_admin', 'platform_owner'] as const;
```

Consequences, all deliberate:
- Platform access is **never** granted through tenant membership. Different table, different flow, different audit stream.
- `roleAtLeast('owner', …)` can never be satisfied by a platform role and vice versa — the two axes do not compare.
- A user can hold both (a Nexara staffer who also owns a demo account) without either leaking into the other.
- Revoking tenant membership never accidentally revokes platform access, or the reverse.

### Three tiers, not one

"Super super admin" implies unrestricted reach. Unrestricted reach for everyone who does support work is how customer data leaks. Split by need:

| Tier | Can | Cannot |
|---|---|---|
| `platform_support` | See all accounts, metadata, usage, billing state, delivery health, error rates, audit logs | Read message **content**; mutate tenant data; impersonate |
| `platform_admin` | Everything above + credit adjustments, suspend/reactivate accounts, clear suppressions, resend/requeue, **time-boxed impersonation** | Grant platform roles; change platform config |
| `platform_owner` | Everything + grant/revoke platform roles, platform configuration | — (2-person rule on role grants; see §5) |

Most day-to-day work is `platform_support`. That tier alone satisfies "see all accounts' activities" without giving anyone the ability to read a customer's conversations.

---

## 3. Console scope

Six surfaces, each answering a question an operator actually has:

| Surface | Contents |
|---|---|
| **Fleet overview** | All accounts: plan, status, credit balance, connected WABA, last activity, 7-day message volume, health flag. Sort/filter/search. |
| **Account detail** | One tenant: members + roles, WhatsApp config and quality rating, template inventory and approval states, broadcast history, credit ledger, onboarding state. |
| **Activity stream** | Cross-tenant event feed from the framework `EventBus` — logins, sends, broadcast runs, onboarding steps, role changes, billing events. Filter by account/type/time. |
| **Delivery health** | Platform-wide Meta error rates by code (per `META_ERROR_TAXONOMY.md`), suppression counts, accounts trending badly, template pauses. This is the early-warning surface. |
| **Billing ops** | Wallets, ledgers, reservations (including stuck/expired), manual credit adjustment with mandatory reason, reconciliation status. |
| **Support tools** | Impersonation (time-boxed, consented, audited), suppression clearing, broadcast requeue, webhook replay. |

Delivery health is the one that pays for the console. Meta quality-rating drops and template pauses are account-killing events that a tenant often notices *after* damage is done.

---

## 4. The architectural tension — and how to resolve it

The architecture guard **requires** `account_id` on every infrastructure SQL statement. The console's whole purpose is cross-account queries. These collide.

Do **not** weaken the guard. Instead:

- Platform queries live in a dedicated `modules/platform-admin/infrastructure` namespace with an **explicit, enumerated** guard exemption — a named allow-list of files, not a pattern that any future code can fall into.
- Every exempted repository method takes an explicit `PlatformPrincipal` argument. There is no implicit ambient authority; a call without a verified platform principal does not compile.
- Every exempted method emits an audit record before returning. Reading across tenants is itself an auditable act.
- The guard script asserts the exemption list has not grown without review — a new entry fails CI until explicitly acknowledged.

This keeps the property that matters — *cross-tenant access is rare, named, and logged* — instead of the weaker *cross-tenant access is forbidden except where someone quietly disabled the check*.

### Serving the fleet view

Do not fan out per-tenant queries across 1,000 accounts. Build the fleet overview and delivery-health surfaces from the **same pre-aggregated rollup tables** the reporting design already requires (`reporting/TRD.md`, `COST_D1_vs_AWS.md`). On D1 this is not optional: rows-scanned billing makes a naive cross-tenant scan a cost incident. The console is a first-class consumer of the rollups, not an afterthought — worth stating in the reporting TRD.

---

## 5. Security requirements

Non-negotiable, because this role defeats tenant isolation by design:

```
MFA mandatory for every platform role — no exceptions, no grace period
Platform roles granted only by platform_owner, with a 2-person rule
Every cross-tenant read audited: who · what account · what data · when · why
Impersonation: time-boxed (≤60 min), reason required, banner visible to the
  impersonated user, full session recorded, auto-expires
Message content access: separate permission, denied to platform_support,
  justification required, retained in the audit log
Audit log append-only and immutable — not writable by any platform role
Separate credential path from tenant auth; platform sessions shorter-lived
Rate-limited and alerted: bulk cross-tenant reads page someone
```

`DO_NOT_BUILD_YET.md` already lists "platform-admin MFA" and "audit log" under carry-over security to apply *during* build, not defer. That holds here.

---

## 6. Data model

```
platform_admins
  user_id (PK) · platform_role · granted_by · granted_at · revoked_at
  · mfa_enrolled_at · last_access_at

platform_audit_log                       -- append-only, no UPDATE/DELETE grant
  id · actor_user_id · platform_role · action · target_account_id
  · target_resource · reason · ip · user_agent · occurred_at
  · request_id                            -- correlates with app logs

platform_impersonation_sessions
  id · actor_user_id · target_account_id · target_user_id
  · reason · started_at · expires_at · ended_at · ended_reason

account_rollup_daily                     -- shared with reporting
  account_id · date · messages_sent · messages_failed · broadcasts_run
  · credits_consumed · active_users · error_counts (jsonb)
  · suppressed_contacts · quality_rating
```

`account_rollup_daily` is deliberately the reporting rollup, not a console-specific copy. One aggregation pipeline, two consumers.

---

## 7. Build sequencing

Nothing here blocks the vertical slice, and the slice should not wait on it. But two pieces must be designed in from the start because retrofitting them is expensive:

| Phase | Item |
|---|---|
| **With the foundation** (not deferrable) | `Principal.platformRole` dimension in the RBAC model; `platform_audit_log` table + write path |
| **After the vertical slice** | Fleet overview, account detail, activity stream (read-only `platform_support` tier) |
| **After billing gates clear** | Billing ops, credit adjustment |
| **Last** | Impersonation — highest risk, needs the audit and consent machinery proven first |

Retrofitting a second principal dimension into an RBAC model that has shipped means touching every authorization call site. Adding an audit log after the fact means the early months have no record. Both are cheap now and expensive later — hence "not deferrable" even though the console itself is.
