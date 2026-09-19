# Deploying `apps/web` to Cloudflare Workers + D1

Nothing here has been run against a real Cloudflare account — no credentials
exist in this environment. Every command below was chosen because it was
either dry-run/local-only and actually executed during this task, or because
it is the standard command for the step and has no local equivalent. Do not
skip-read this before running it against production.

## 0. One-time fragile point — READ FIRST

`apps/web` must **not** have its own `package-lock.json` (or any lockfile).
`@opennextjs/cloudflare`'s build walks up from `apps/web` looking for the
nearest lockfile to decide where the "monorepo root" is. If it finds one
*inside* `apps/web`, it stops there — which disagrees with
`next.config.ts`'s `turbopack.root` (pinned to `app-v2`, for the unrelated
reason documented in that file) and breaks `opennextjs-cloudflare build`
with `ENOENT ... middleware.js.nft.json` while bundling the Node.js
proxy/middleware (this app's `proxy.ts` runs on the Node.js runtime by
default in this Next.js version — see `proxy.ts`'s own header).

This is not hypothetical: it happened during this task (a lockfile got
created in `apps/web` by an `npm install` run from that directory) and was
fixed by deleting it, which is why `apps/web/.gitignore` now excludes
`package-lock.json` with a comment explaining this. **If the build starts
failing with that ENOENT again, check for `apps/web/package-lock.json`
first** — do not "fix" it by changing `turbopack.root` instead, that
reintroduces the problem `turbopack.root`'s own comment describes (the
sibling `/home/user/wacrm` checkout's lockfile hijacking root detection).

Installing packages into `apps/web` is still fine — run `npm install` from
`app-v2` (the root with the real lockfile), or `npm install --no-package-lock`
from `apps/web`.

## 1. Prerequisites

- `wrangler login` (interactive; needs real Cloudflare credentials this
  environment does not have).
- From `app-v2/apps/web`: `npm install` (already done in this checkout).

## 2. Create the D1 database

```
cd app-v2/apps/web
npx wrangler d1 create wacrm-web
```

Copy the `database_name` and `database_id` it prints into
`wrangler.jsonc`'s `d1_databases[0]`, replacing the two
`REPLACE_WITH_YOUR_D1_DATABASE_*` placeholders. `binding` must stay `"DB"` —
that is the literal name `lib/container.ts`'s `buildD1BaseServices` reads
off `env.DB`.

## 3. Apply migrations

The real migration stream is `db/migrations/d1/0001_identity.sql` through
`0012_message_retention.sql` — 12 files, already numbered
`NNNN_name.sql`. This is exactly `wrangler`'s own default naming
convention (verified locally: `wrangler d1 migrations list`/`apply --local`
recognized and applied all 12, in order, unmodified — see "What was
verified" below). No renames needed; `wrangler.jsonc` points
`migrations_dir` straight at `db/migrations/d1` rather than a copy.

```
npx wrangler d1 migrations apply wacrm-web --remote
```

(Omit `--remote` first against `--local` if you want to sanity-check
against Miniflare's local D1 before touching the real one.)

This creates the schema only — no seed data. **Do not** point any
seed/demo script at the production database; `lib/container.ts` enforces
this structurally (see §5).

### Provisioning the first user

Nothing here creates a login-capable account — that is a deliberate gap
(see §5, "single-tenant auth"), not an oversight. Before anyone can log in,
insert one row each into `accounts`, `users`, and `credentials`
(`db/migrations/d1/0001_identity.sql`, `0011_credentials.sql`) with a
matching `tenant_id`/`account_id`, via `wrangler d1 execute wacrm-web
--remote --file=...`. The password hash format is
`pbkdf2-sha256$<iterations>$<salt>$<hash>`, produced by
`nexara/core/auth`'s hashing code (currently being changed in a concurrent
task — read that file for the current function name rather than trusting a
copy of it here). Use the `AUTH_TENANT_ID` value from §4 as both
`accounts.id` and the row's `tenant_id`.

## 4. Set secrets and vars

| Name | Kind | Read by | Notes |
|---|---|---|---|
| `AUTH_SECRET` | secret | `lib/container.ts` | ≥32 bytes, high-entropy. Throws at cold start if unset — this is intentional, do not set a default. |
| `META_APP_SECRET` | secret | `lib/webhook-signature.ts` | Meta App secret; HMACs inbound webhook bodies. Throws per-request if unset. |
| `META_WEBHOOK_VERIFY_TOKEN` | secret | `lib/webhook-signature.ts` | The token Meta's webhook GET handshake must present. Throws per-request if unset. |
| `AUTH_TENANT_ID` | secret or var | `lib/container.ts`'s `buildD1BaseServices` | **New requirement this task introduced** — see §5. Must equal the `accounts.id`/`tenant_id` used in §3's provisioning insert. |

```
npx wrangler secret put AUTH_SECRET
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN
npx wrangler secret put AUTH_TENANT_ID
```

## 5. Build and deploy

```
npm run cf:build     # opennextjs-cloudflare build
npm run cf:preview   # + wrangler dev, local-only smoke test
npm run cf:deploy    # + opennextjs-cloudflare deploy (needs wrangler login)
```

---

## What changed and why

### The provider split (`lib/container.ts`)

`isWorkersRuntime()` checks `navigator.userAgent === "Cloudflare-Workers"` —
workerd's own self-identification, present under both `wrangler dev` and a
real deployment, absent in Node (`next dev`, `vitest run`). This is the
*only* switch between two builders:

- `buildDevBaseServices()` — unchanged sql.js + `runMigrations` +
  `SEEDERS` path. Still what runs under `next dev` and `vitest run`.
- `buildD1BaseServices()` — reads the `DB` binding via
  `getCloudflareContext({ async: true })` (`@opennextjs/cloudflare`), builds
  `D1DatabaseProvider`, and runs **no migrations and no seeding**. Both are
  structurally unreachable from this path (the functions that do them are
  simply never called here, not merely skipped by a flag), so there is no
  code path that can seed demo data into a real D1 database.

### Rate limiting — configured, and it must stay configured

`wrangler.jsonc` declares a `ratelimits` binding, `AUTH_RATE_LIMITER`, at 20
requests per 60 seconds per IP. `lib/rate-limit.ts` reads it and applies a
separate counter to `/api/auth/login` and `/api/auth/signup`.

Both endpoints are reachable without a session, and both are expensive in a
way that matters on the free tier:

| Endpoint | Cost per call | Free-tier quota it eats |
|---|---|---|
| `/api/auth/login` | ~6ms CPU (PBKDF2) | 10ms CPU budget per request |
| `/api/auth/signup` | 4 row writes | 100,000 writes/day, product-wide |

~25,000 unthrottled signup calls exhaust a day's write quota for every
tenant. That is a denial of service with a curl loop, not spam.

**It fails open when the binding is absent**, which is right for local dev and
wrong to discover in production. `wrangler deploy --dry-run` prints the
bindings it resolved — check `env.AUTH_RATE_LIMITER (20 requests/60s)` appears
before you believe the protection exists. `lib/rate-limit.test.ts` covers the
fail-open path explicitly, including that `enforced: false` distinguishes
"within budget" from "never checked".

Two honest limits. The counter is **per-colocation, not global**, so a
distributed attacker's real ceiling is higher than 20; and the window is fixed
at 10 or 60 seconds, so an attacker pacing below the limit is not slowed at
all. This is a flood brake for the cheap single-machine attack, which is the
one that actually shows up. It is not a lockout, and it is not a substitute
for the 12-character password minimum — which is what actually compensates for
PBKDF2 running below the OWASP iteration floor.

### Multi-tenant auth — resolved

One Workers deployment serves EVERY tenant in its D1 database.

Two things make that true:

- **Login resolves the tenant from the credential.** A login request carries
  an email and a password and nothing that names a tenant, so
  `findByEmailAnyTenant` finds the one credential with that address and the
  session is issued for the tenant on that row. Unambiguous because
  `credentials.email` is globally unique
  (`0013_global_email_uniqueness.sql`), which is the same rule
  `0002_organizations.sql` already locked as "one account per user", stated
  where login can act on it.
- **Session verification scopes by the token's own tenant claim**, not by the
  tenant the container was configured with. The claim is trustworthy because
  the signature, issuer and audience have already been checked — an attacker
  cannot choose it without the signing key.

It previously worked the other way: `getCurrentUser` looked the user id up in
the CONFIGURED tenant, so a token issued for one tenant resolved inside
whichever tenant the deployment happened to name. Harmless while one
deployment served one customer; a cross-tenant identity the moment that
stopped being true.

`AUTH_TENANT_ID` survives, with a much smaller job: the tenant that NEW
credentials are created in, for registration, password reset and email
verification — flows that carry no token to read a tenant from. It no longer
has anything to do with whose sessions this deployment can verify.

`nexara/core/auth/providers/jwt-auth-provider.test.ts` holds the isolation
cases, including the one that matters: the same user id existing in two
tenants, where a token for one must not resolve to the other. Both fail if
session verification ever goes back to the configured tenant — verified by
reverting the change and watching them break.

### D1 has no interactive transactions

Not touched — no `.transaction(` call was introduced;
`node scripts/check-architecture.mjs` (rule 2b) still passes.

### `node:crypto` under `nodejs_compat` — verified, not assumed

Ran a minimal worker under `wrangler dev --local` (no account needed)
calling `createHmac`/`timingSafeEqual`/`Buffer` from `node:crypto` — all
three work correctly under workerd with the `nodejs_compat` flag. This is
what `lib/webhook-signature.ts` (Meta's HMAC-SHA256 signature check) relies
on.

## What was verified (real output, this environment)

1. `cd app-v2 && npx tsc --noEmit` — clean.
2. `cd apps/web && npx tsc --noEmit` — clean.
3. `node scripts/check-architecture.mjs` — passes.
4. `npx vitest run` — 909 tests pass (902 in the task's stated baseline +
   7 added by an unrelated concurrent commit already on this branch before
   this task started; nothing dropped by this work).
5. `npx next dev` — logged in as `owner@demo.test` /
   `Wacrm-Demo-2026!`, loaded `/contacts` (200), server killed after.
6. `npx opennextjs-cloudflare build` — **succeeds**, produces
   `.open-next/worker.js` + `.open-next/assets`.
7. `npx wrangler deploy --dry-run` — resolves `env.DB` and `env.ASSETS`
   bindings correctly from `wrangler.jsonc`, no network call made.
8. `npx wrangler d1 migrations list/apply <db> --local` — all 12 files in
   `db/migrations/d1` recognized in order and applied cleanly to a local D1
   (Miniflare's real SQLite-backed D1 emulation, not sql.js).
9. `npx wrangler dev` (local only) against the locally-migrated D1, with
   placeholder secrets: `/login` 200, `/contacts` without a cookie 307,
   `/api/contacts` without a cookie 401, `POST /api/auth/login` against an
   empty (unseeded) D1 → 401 `invalid_credentials` (no crash — confirms the
   D1 path runs end to end and seeds nothing), webhook GET with a wrong
   verify token → 403, webhook POST with a bad signature → 401.

None of the above created, modified, or deployed anything in a real
Cloudflare account.

## Remaining incompatibilities / open items

- **Single-tenant auth** (above) — real limitation, not fixed, out of
  scope's file list.
- **No account-provisioning tool.** §3's manual insert is the only way to
  create a login-capable user today; there is no signup flow in scope here.
- **Node.js middleware on Workers is upstream-labeled experimental**
  (`@opennextjs/cloudflare`'s own build output: "Node.js middleware support
  is experimental in cloudflare, and not officially maintained by OpenNext
  maintainers"). `proxy.ts` runs on the Node.js runtime by default in this
  Next.js version and there is no supported way to force it back to the
  edge runtime (the docs say setting `runtime` in a Proxy file throws). It
  built and ran correctly in every check above, but it is riding an
  adapter code path its own maintainers do not fully support yet.
- **ISR/data cache is a no-op in this config** (`open-next.config.ts` uses
  the default "dummy" incremental cache — no R2 bucket, so nothing is
  cached across requests). Fine for this app (everything is
  dynamic/session-scoped), called out in case that ever changes.
- **`apps/web/package-lock.json` fragility** — see §0. Structural, but easy
  to reintroduce by running the wrong `npm install` from the wrong
  directory.
