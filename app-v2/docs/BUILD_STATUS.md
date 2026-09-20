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
| Inbox | conversation list, thread, mark-read, assign (assignee membership checked), reply composer — text and template, verified in a real browser |
| Broadcasts | list, create, schedule, pause/resume/cancel, report, audience preview with skips grouped by reason |
| Team / seats | usage, members, invitations, cap proven at 3/3; invite → email → accept → login verified end to end |
| Auth | password login, PBKDF2 (Workers-safe), 12-char minimum, 3h/1h sessions, revocation |
| Multi-tenancy | one deployment serves every tenant; login resolves tenant from the credential, sessions from the token claim; isolation verified live |
| Signup | self-serve tenant creation, all four rows in one `batch()`, atomicity proven |
| Platform console | audit log, compliance cases (two-person, TTL'd, scoped); staff cannot browse message content |
| WhatsApp inbound | signature-verified (raw bytes, constant-time), idempotent, messages reach the inbox |
| WhatsApp outbound | text, template, media, interactive — all four reachable from the inbox composer and verified in a browser; every send goes through one consent/suppression failure mapping (`apps/web/lib/send-plumbing.ts`) |
| Media upload | `POST /api/media` turns a browser file into a Meta media id; 5 MB cap checked twice, closed MIME allow-list |
| Rate limiting | login + signup, Cloudflare binding, IP-keyed, fails open |
| Cloudflare | `opennextjs-cloudflare build` succeeds; worker runs under `wrangler dev` against migrated D1 |
| Retention | 60-day policy, migration, SQL sweep, and a daily Cron Trigger (09:00 UTC) with a per-run write budget. Fired locally against real D1; rows deleted. |

## Next, in order

1. **WhatsApp number settings** — a tenant cannot connect its own number;
   config rows are seeded by hand. The cipher this needs now exists and is
   tested (`nexara/core/crypto/secret-box.ts`, AES-256-GCM, context-bound,
   0.117 ms per seal+open round trip measured — against PBKDF2's 6.2 ms it is
   free), but NOTHING USES IT YET. Remaining, in order: seal on write and open
   on read in the WhatsApp config repository; a one-way migration for the
   plaintext rows that exist (`isSealed` distinguishes them); a
   `SECRET_ENCRYPTION_KEY` Worker secret that the container refuses to start
   without in production, the way it already refuses a missing `AUTH_SECRET`;
   then the screen.
2. **~20 unported screens** — dashboard, settings, templates, automations,
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
- **The contract and the vendor port disagree on purpose.** The wire
  `interactivePayloadSchema` tags its button variant `kind: "button"` (Meta's
  `interactive.type`); the provider port tags it `kind: "buttons"` (the vendor
  `buttons[]` field). `apps/web/lib/interactive-payload.ts` maps between them
  explicitly — a cast there would compile and lie. Likewise the contract's
  media enum carries `sticker`, which the port does not model: the route
  refuses it with a 422 rather than widening the port.

- **Hashing and encryption are not interchangeable.** A Meta access token is
  sent to Meta on every message, so it must be recoverable — `hashToken` is
  the wrong tool and reaching for it is how a token ends up stored in the
  clear instead. `secret-box.ts` is the reversible half, and its ciphertexts
  are bound to the row they belong to (GCM additional data), so a sealed
  token moved into another tenant's config row fails to open rather than
  quietly sending that tenant's traffic on someone else's credentials.

- **A route with no UI is not a shipped feature.** Text send had a route,
  contract, tests and a service layer for weeks, and no composer — nobody
  could reply to a customer. The same pattern had already produced an invite
  token nobody could receive. A slice is done when a person can reach it.

- **Never trust a tenant from a request.** Derive it from a verified token, or
  from a row found by a globally-unique key. Signup ignores a client-supplied
  account id; the webhook resolves its tenant from `phone_number_id`.
