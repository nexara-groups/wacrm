# Build status — app-v2

The single place recording what is built, what is not, and what is deliberately
blocked. The scheduled build routine reads this and picks the next item, so it
must stay accurate: a stale line here sends work in the wrong direction.

Update it in the same commit as the work it describes.

## Working and verified end to end

Verified means exercised against a running server or asserted by a test that
fails without the code — not "the report said so".

| Area | State |
|---|---|
| Contacts | list, search, create; phone normalisation through the whole stack |
| Inbox | conversation list, thread, mark-read, assign (assignee membership checked) |
| Broadcasts | list, create, schedule, pause/resume/cancel, report, audience preview with skips grouped by reason |
| Team / seats | usage, members, invitations, cap proven at 3/3, real tokens for invite redemption |
| Auth | password login, PBKDF2 (Workers-safe), 12-char minimum, 3h/1h sessions, revocation |
| Multi-tenancy | one deployment serves every tenant; login resolves tenant from the credential, sessions from the token claim; isolation verified live |
| Signup | self-serve tenant creation, all four rows in one `batch()`, atomicity proven |
| Platform console | audit log, compliance cases (two-person, TTL'd, scoped); staff cannot browse message content |
| WhatsApp inbound | signature-verified (raw bytes, constant-time), idempotent, messages reach the inbox |
| WhatsApp outbound | text send only |
| Rate limiting | login + signup, Cloudflare binding, IP-keyed, fails open |
| Cloudflare | `opennextjs-cloudflare build` succeeds; worker runs under `wrangler dev` against migrated D1 |
| Retention | 60-day policy, migration, SQL sweep, and a daily Cron Trigger (09:00 UTC) with a per-run write budget. Fired locally against real D1; rows deleted. |

## Next, in order

1. **An accept-invitation route.** The invite email links to
   `/accept-invite?token=...` and no such route or page exists, so invitations
   now reach people and still cannot be accepted. `SeatService.acceptInvitation`
   and the token lookup are wired and tested in `modules/`; nothing in
   `apps/web` calls them. This is the last step between "invitations exist" and
   "invitations work".
2. **Remaining send routes** — template, media, interactive. The service layer
   handles all of them; only text has a route.
3. **~20 unported screens** — dashboard, settings, templates, automations,
   flows, pipelines, notifications, agents, forgot-password, join-by-invite,
   and the `/admin` fleet views.

## Deliberately blocked — do not build

- **Credit ledger / reservation / settlement.** Gated by
  `META_COMMERCIAL_BILLING_MODEL.md`. Separate from the database decision, and
  still closed. The four correctness criteria in `DATABASE_DECISION.md` are
  about this wallet, and none of them have been demonstrated on D1.
- **Fleet overview / billing ops / support tools** in platform-admin. Contracts
  exist; no persistence. Fleet overview needs an `account_rollup_daily` table
  the spec requires and no migration creates — a schema decision, not a coding
  task.

## Constraints that have already bitten

Each of these cost real time or shipped a bug. They are not style preferences.

- **D1 free tier meters rows READ.** Any query whose cost scales with table
  size rather than page size is a bug. Four routes once walked whole tables to
  render one page.
- **10ms CPU per request.** bcrypt took 277ms; PBKDF2 at 40,000 iterations
  takes 6.2ms. This is why iterations sit below the OWASP floor, and why the
  12-character minimum and the rate limiter matter.
- **No interactive transactions.** `transaction()` throws on D1. Use `batch()`.
  `scripts/check-architecture.mjs` rule 2b fails the build otherwise.
- **`apps/web/package-lock.json` must not exist.** It makes the OpenNext
  bundler infer the wrong monorepo root and the build dies with ENOENT on
  `middleware.js.nft.json`. Reproducible installs come from `app-v2/`'s
  lockfile, one level up.
- **Foreign keys are ON in the sql.js harness**, matching D1. Do not turn this
  off to make a test pass; it exists because a retention delete that looks fine
  with FKs off is rejected by D1.
- **Never trust a tenant from a request.** Derive it from a verified token, or
  from a row found by a globally-unique key. Signup ignores a client-supplied
  account id; the webhook resolves its tenant from `phone_number_id`.
