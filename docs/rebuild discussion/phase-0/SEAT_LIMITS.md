# SEAT_LIMITS — Sub-Users Per Account, With a Cap

Every account creates its own sub-users. The number must be capped, and the cap must be a **provision** — configurable per account and per plan, not a constant in the code.

---

## 1. What exists today (verified)

| | Current state |
|---|---|
| Membership | `profiles.account_id` + `profiles.account_role` — the source of truth |
| Roles | `account_role_enum` = `owner` / `admin` / `agent` / `viewer` |
| Invitations | `account_invitations` (token hash, role, expiry, `CHECK (role <> 'owner')`) |
| **Seat cap** | **Does not exist.** No column, no check, no enforcement anywhere. |

An account can invite unbounded members today. Since seats are the natural billing lever for a CRM, and every invited user consumes real resources, this needs to land with the organizations module rather than be retrofitted.

Note the role vocabulary differs from the framework's (`owner`/`admin`/`manager`/`member` in `nexara-repo-framework/src/core/rbac/roles.ts`). The port must reconcile the two — `agent`→`member`, `viewer`→ either a `member` variant or a fifth role. Decide during the organizations port; do not carry both vocabularies.

---

## 2. Model

The cap is resolved, not stored in one place — so a plan change lifts every account on that plan, while a single account can still be granted an exception.

```
resolved_seat_limit(account) =
    account.seat_limit_override          -- per-account grant, nullable
 ?? plan.included_seats                  -- from the account's plan
 ?? DEFAULT_SEAT_LIMIT                   -- platform floor, config not literal
```

```
accounts
  + seat_limit_override   INTEGER          -- NULL = inherit from plan
  + seat_limit_reason     TEXT             -- why this account got an exception
  + seat_limit_set_by     UUID             -- platform actor
  + seat_limit_set_at     TIMESTAMPTZ

plans
  included_seats          INTEGER NOT NULL
  max_seats               INTEGER          -- NULL = unlimited purchasable
  extra_seat_price        NUMERIC          -- NULL = seats not purchasable

seat_usage_events         -- append-only; billing and dispute evidence
  id · account_id · delta · reason · actor_user_id · occurred_at
```

### What counts as a seat

Ambiguity here becomes a billing dispute, so it must be explicit:

| Counts | Does not count |
|---|---|
| Active member (any role, **including `owner`**) | Removed / deactivated member |
| **Pending invitation** (not yet accepted) | Expired or revoked invitation |
| | Nexara platform staff acting via the console |

**Pending invitations must count.** Otherwise an account on a 5-seat plan issues 50 invitations and ends up with 50 members, and the cap was decorative. Reserve the seat at invitation, release it on expiry or revocation.

`owner` counts. A 5-seat plan means five people total, not an owner plus five — anything else is a support conversation every time.

---

## 3. Enforcement

One authority, checked at every write path. A cap enforced only in the UI is not a cap.

```
SeatService.assertCanAddSeat(accountId) →
    Result<void, SeatLimitExceeded>
```

Called by:

| Path | Behaviour at the cap |
|---|---|
| Create invitation | Refuse with the plain-English message + upgrade CTA |
| Accept invitation | **Re-check** — the cap may have been reduced, or another invite accepted first |
| Direct user creation (platform console) | Refuse unless the actor overrides with a reason (audited) |
| Reactivate a deactivated member | Refuse if at cap — reactivation consumes a seat |
| Plan downgrade | See §4 |

The accept-time re-check is the one most often missed. Two invitations issued at 4/5 seats, both accepted, is 6 seats without it. Both the reservation and the accept must be **atomic against concurrent accepts** — this is the same class of concurrency problem as the credit wallet's hot row, so it belongs in the DB benchmark's contract tests (`DATABASE_DECISION.md`).

### Plain-English messages

| Situation | Shown to the account |
|---|---|
| At cap, inviting | "You've used all 5 user seats on your plan. Remove a user or upgrade to add more." |
| Pending invites consuming seats | "4 of 5 seats used — 2 are pending invitations that haven't been accepted yet." |
| Accept fails (cap reached meanwhile) | "This workspace has no free seats. Ask the account owner to free one or upgrade." |
| Approaching cap | "1 seat left on your plan." |

Same rules as `META_ERROR_TAXONOMY.md` §4b: no jargon, say what happened and what to do next.

---

## 4. Downgrade — the hard case

An account on 20 seats downgrades to a 5-seat plan with 12 active users. Deleting 7 people silently is unacceptable; ignoring the cap makes it meaningless.

**Grandfather, then block growth:**

1. Existing members are **never** auto-removed. Ever.
2. The account enters `over_seat_limit` — visible, explained, with the count.
3. No new invitations and no reactivations until usage is at or under the cap.
4. Removing a member decrements usage; the block lifts at the cap.
5. Optionally, billing charges for overage seats at `extra_seat_price` if the plan allows purchasable seats. If it does not, the account simply stays blocked from growth.
6. Grace period is a **plan setting**, not hardcoded.

The state is legible and self-clearing, and no customer loses access to a user account because of a billing change. Platform staff can see every `over_seat_limit` account from the fleet overview (`SUPER_ADMIN_CONSOLE.md` §3) — it is an upsell signal as much as a compliance one.

---

## 5. Platform console integration

Per `SUPER_ADMIN_CONSOLE.md`:

| Tier | Seat capability |
|---|---|
| `platform_support` | See seat usage and limits for every account |
| `platform_admin` | Set `seat_limit_override` with a mandatory reason (audited) |
| `platform_superadmin` | Change plan-level `included_seats` |

Every override writes to `platform_audit_log` and `seat_usage_events`. "Why does this account have 50 seats on a 5-seat plan" must always have an answer with a name attached.

---

## 6. Provision for later — design now, build later

Columns and interfaces shaped to allow these; **do not build them now**:

- **Per-role seat pricing** — a `viewer` costing less than an `agent`. Keep `seat_usage_events.delta` numeric rather than boolean so weighted seats are possible.
- **Concurrent-session limits** — distinct from seat count; `device_installations` (`AUTH_EXTENSION.md`) already carries what this would need.
- **Seat pooling across accounts** for a reseller or agency owning several client accounts.
- **Time-boxed seats** for contractors — `expires_at` on membership.

Per `DO_NOT_BUILD_YET.md`'s complexity gate: the schema allows them, the code does not implement them.

---

## 7. Test requirements

```
Cap enforced at invitation creation
Cap re-enforced at invitation acceptance
Two concurrent accepts at (cap − 1) → exactly one succeeds
Pending invitations count toward usage
Expired/revoked invitations release their seat
Owner counts toward the cap
Reactivating a member at cap is refused
Downgrade never removes an existing member
over_seat_limit blocks invitations, clears on member removal
seat_limit_override takes precedence over plan
Override requires a reason and writes an audit record
Seat counts are tenant-scoped
```

---

## 8. Build sequencing

| Phase | Item |
|---|---|
| **With the organizations module** (not deferrable) | `resolved_seat_limit`, `SeatService`, enforcement at invite + accept, `seat_usage_events` |
| With billing | Purchasable extra seats, overage charging, downgrade grace |
| With the console | Override UI, fleet-wide seat reporting |
| Deferred | Per-role pricing, session limits, pooling, time-boxed seats |

Enforcement lands with the organizations module because retrofitting a cap onto an account set that has already grown past it means a migration plus a customer conversation. Cheap now, awkward later.
