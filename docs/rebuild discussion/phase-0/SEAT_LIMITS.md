# SEAT_LIMITS — Sub-Users Per Account, With a Cap

Every account creates its own sub-users. The number must be capped, and the cap must be a **provision** — configurable at platform level, per plan, and per account, never a constant in the code.

**Default: 3 seats.** Any account that wants more is raised from the console, with a reason, without a deploy.

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

**Default cap is 3 seats.** That is a *configured value*, never a constant in the code — changeable platform-wide, and overridable for any individual account that asks.

The cap is resolved through three levels, most specific wins:

```
resolved_seat_limit(account) =
    account.seat_limit_override                -- 1. per-account grant  (nullable)
 ?? plan.included_seats                        -- 2. the account's plan (nullable)
 ?? platform_settings.default_seat_limit       -- 3. platform default   (= 3)
```

| Level | Who changes it | Effect |
|---|---|---|
| **Platform default** | `platform_superadmin` | Moves every account not covered by a plan or an override |
| **Plan** | `platform_superadmin` | Moves every account on that plan |
| **Account override** | `platform_admin`+ | Moves exactly one account — *"if any account wants more, we manage it"* |

Nothing is hardcoded at any level. Raising one account from 3 to 10 is a console action with a reason, not a deploy.

```
platform_settings                  -- single-row platform configuration
  default_seat_limit      INTEGER NOT NULL DEFAULT 3
  ...other platform-wide defaults

accounts
  + seat_limit_override   INTEGER          -- NULL = inherit from plan/platform
  + seat_limit_reason     TEXT             -- why this account got an exception
  + seat_limit_set_by     UUID             -- platform actor
  + seat_limit_set_at     TIMESTAMPTZ

plans
  included_seats          INTEGER          -- NULL = inherit platform default
  max_seats               INTEGER          -- NULL = unlimited purchasable
  extra_seat_price        NUMERIC          -- NULL = seats not purchasable

seat_usage_events         -- append-only; billing and dispute evidence
  id · account_id · delta · reason · actor_user_id · occurred_at
```

A changed platform default or plan value applies **immediately** to accounts inheriting it. Lowering it can put accounts over their cap — that is the `over_seat_limit` path in §4, never a removal.

### What counts as a seat

Ambiguity here becomes a billing dispute, so it must be explicit:

| Counts | Does not count |
|---|---|
| Active member (any role, **including `owner`**) | Removed / deactivated member |
| **Pending invitation** (not yet accepted) | Expired or revoked invitation |
| | Nexara platform staff acting via the console |

**Pending invitations must count.** Otherwise an account on a 3-seat plan issues 50 invitations and ends up with 50 members, and the cap was decorative. Reserve the seat at invitation, release it on expiry or revocation.

`owner` counts. A 3-seat plan means three people total — the owner plus two others — not an owner plus three. Anything else is a support conversation every time.

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

The accept-time re-check is the one most often missed. At 2 of 3 seats used, two invitations both accepted is 4 seats without it. Both the reservation and the accept must be **atomic against concurrent accepts** — this is the same class of concurrency problem as the credit wallet's hot row, so it belongs in the DB benchmark's contract tests (`DATABASE_DECISION.md`).

### Plain-English messages

| Situation | Shown to the account |
|---|---|
| At cap, inviting | "You've used all 3 user seats on your plan. Remove a user or upgrade to add more." |
| Pending invites consuming seats | "3 of 3 seats used — 1 is a pending invitation that hasn't been accepted yet." |
| Accept fails (cap reached meanwhile) | "This workspace has no free seats. Ask the account owner to free one or upgrade." |
| Approaching cap | "1 seat left on your plan." |

Same rules as `META_ERROR_TAXONOMY.md` §4b: no jargon, say what happened and what to do next.

---

## 4. Downgrade — the hard case

An account on 10 seats downgrades to the default 3 with 8 active users. Deleting 5 people silently is unacceptable; ignoring the cap makes it meaningless.

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
| `platform_superadmin` | Change plan-level `included_seats` **and** the platform default |

Every override writes to `platform_audit_log` and `seat_usage_events`. "Why does this account have 25 seats when the default is 3" must always have an answer with a name attached.

The fleet overview shows `used / limit` per account and flags every account carrying an override, so grants stay visible rather than accumulating unnoticed.

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
Default resolves to 3 with no plan and no override
Plan value overrides the platform default; account override beats both
Changing the platform default moves inheriting accounts immediately
Changing the platform default does NOT move accounts with an override
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
| **With the organizations module** (not deferrable) | `platform_settings.default_seat_limit` (= 3), `resolved_seat_limit`, `SeatService`, enforcement at invite + accept, `seat_usage_events`, per-account override |
| With billing | Purchasable extra seats, overage charging, downgrade grace |
| With the console | Override UI, fleet-wide seat reporting |
| Deferred | Per-role pricing, session limits, pooling, time-boxed seats |

Enforcement lands with the organizations module because retrofitting a cap onto an account set that has already grown past it means a migration plus a customer conversation. Cheap now, awkward later.
