# META_ERROR_TAXONOMY — Error Classification, Plain-English Messages, Number Suppression

Three requirements in one design, because they are the same mechanism:

1. Classify every Meta/WhatsApp Cloud API error.
2. Show users plain English, not Meta's developer strings.
3. When an error means *this number will never work*, **mark the number and stop trying** — no retry, excluded from future sends.

> **Verify before implementing.** The code list below reflects Meta's published Cloud API error reference and is accurate to the best of current knowledge, but Meta revises codes and semantics without notice. Treat this as the design and the starting table — reconcile every code against live Meta documentation during implementation, and make the table data, not hardcoded logic, so it can be corrected without a deploy.

---

## 1. What exists today (verified)

| | Current state |
|---|---|
| Error capture | `throwMetaError()` in `src/lib/whatsapp/meta-api.ts` (1044 lines) — extracts `error.message`, throws `Error(...)`. Called at **20+** sites. |
| Storage | `broadcast_recipients.error_message TEXT` — free text only. **No `error_code` column.** |
| Classification | None. Every failure is equally `'failed'`. |
| User-facing text | Meta's raw developer string, surfaced directly to the end user. |
| Retry | "Retry Failed" button re-queues **every** failed recipient indiscriminately. |
| Number health | **Does not exist.** `contacts` has no deliverability state — no way to record that a number is unreachable. |

So a number that is not on WhatsApp gets retried on every broadcast, forever, burning a send attempt and — once billing lands — a credit reservation each time. This is the bug the requirement is pointing at.

---

## 2. Classification model

Four dispositions. Each error code maps to exactly one.

| Disposition | Meaning | Retry? | Marks the number? |
|---|---|---|---|
| `TRANSIENT` | Meta-side or network hiccup | ✅ backoff + jitter, capped attempts | No |
| `THROTTLED` | Rate/quota limit hit | ✅ requeue with delay, respect window | No |
| `PERMANENT_NUMBER` | **This number cannot receive messages** | ❌ **never** | ✅ **yes** |
| `PERMANENT_CONFIG` | Our account/template/token is misconfigured | ❌ not without a fix | No — pause the campaign, alert the account |

The distinction that matters: `PERMANENT_NUMBER` is the recipient's fault and is per-contact. `PERMANENT_CONFIG` is *our* fault and is per-account — retrying it on other numbers will fail identically, so the right response is to stop the whole run and tell the operator, not to mark 3,000 contacts bad.

---

## 3. The code table

`error_code` → disposition → plain-English message. **This is seed data for a `meta_error_codes` table**, editable without deploying.

### PERMANENT_NUMBER — mark the contact, never retry

| Code | Meta's meaning | Plain English (shown to user) |
|---|---|---|
| `131026` | Message undeliverable | "This number isn't on WhatsApp, or can't receive messages. We've stopped sending to it." |
| `131021` | Recipient cannot be sender | "This is your own WhatsApp number — you can't message yourself." |
| `131009`* | Parameter value not valid *(when the invalid parameter is the phone number)* | "This phone number isn't valid. Check the country code and format." |

\* `131009` is generic — it is `PERMANENT_NUMBER` **only** when the offending parameter is the recipient number. Otherwise it is `PERMANENT_CONFIG`. Inspect the error detail before dispatching; when ambiguous, treat as `PERMANENT_CONFIG` (safer — never wrongly suppress a good number).

### PERMANENT_CONFIG — stop the run, alert the operator

| Code | Meta's meaning | Plain English |
|---|---|---|
| `131047` | Re-engagement required (24-hour window closed) | "It's been over 24 hours since this person last messaged you. Use an approved template to reach them." |
| `132001` | Template does not exist / not approved in that language | "This template isn't approved for the language you're sending in." |
| `132000` | Parameter count mismatch | "This template expects a different number of values than were provided." |
| `132015` | Template paused | "This template is paused because of poor quality ratings. Edit it or use a different one." |
| `132016` | Template disabled | "This template has been disabled by Meta and can't be used." |
| `132012` | Parameter format mismatch | "One of the values in this template is in the wrong format." |
| `132005` | Hydrated text too long | "The filled-in template message is too long to send." |
| `131031` | Business account restricted | "Your WhatsApp Business account has been restricted by Meta. Check WhatsApp Manager." |
| `131042` | Business eligibility / payment issue | "There's a billing problem on your WhatsApp Business account. Check your payment method with Meta." |
| `133010` | Phone number not registered | "This WhatsApp number isn't registered yet. Finish setup before sending." |
| `190` | Access token expired/invalid | "Your WhatsApp connection has expired. Reconnect your account." |
| `10`, `200-299` | Permission denied | "We don't have permission to do this. Reconnect your WhatsApp account." |

### THROTTLED — requeue with delay

| Code | Meta's meaning | Plain English |
|---|---|---|
| `130429` | Cloud API throughput limit | "Sending too fast — we'll slow down and keep going." |
| `131048` | Spam rate limit | "Meta has temporarily limited your sending. We'll retry shortly." |
| `131056` | Business/recipient pair rate limit | "Too many messages to this contact right now. We'll retry shortly." |
| `4` | App-level too many calls | "We've hit a temporary limit. Sending will resume automatically." |
| `80007` | WABA rate limit | "Your account's sending limit was reached. Sending resumes automatically." |
| `133016` | Register/deregister rate limit | "Too many setup attempts. Wait a few minutes and try again." |

### TRANSIENT — retry with backoff

| Code | Meta's meaning | Plain English |
|---|---|---|
| `131000` | Generic "something went wrong" | "Something went wrong on WhatsApp's side. We'll try again." |
| `131016` | Service unavailable | "WhatsApp is temporarily unavailable. We'll try again." |
| `133004` | Server temporarily unavailable | "WhatsApp is temporarily unavailable. We'll try again." |
| `131052` / `131053` | Media download / upload error | "We couldn't process the attached file. We'll try again." |
| `131057` | Account in maintenance mode | "Your account is in maintenance mode. Sending resumes automatically." |
| HTTP `5xx`, network | — | "Connection problem. We'll try again." |

### The deliberate non-entry

`131049` ("Meta chose not to deliver — healthy ecosystem / marketing limit") is **THROTTLED, not PERMANENT_NUMBER.** It is a per-user marketing-frequency cap, not a bad number. Suppressing on `131049` would permanently delete reachable customers from every future campaign. Plain English: *"Meta limited marketing messages to this person right now. We'll try again later."*

### Unknown codes

Default to `TRANSIENT` with a **low** retry cap (2), log the raw payload, and surface *"Something went wrong sending this message. Our team has been notified."* Never default an unrecognised code to `PERMANENT_NUMBER` — the cost of wrongly suppressing a customer is much higher than the cost of one wasted retry.

---

## 3b. Opt-out / DND — suppression that is not an error

An error code is not the only reason to stop sending to a number. A person who replies **STOP** never produces a Meta error at all — the message delivers perfectly. But sending to them again is worse than a technical failure: it is a compliance breach and it damages the account's quality rating, which Meta uses to throttle the whole WABA.

So suppression has **two independent sources**:

| Source | Trigger | Reversible by |
|---|---|---|
| **Technical** | `PERMANENT_NUMBER` error code — not on WhatsApp, invalid number | Operator (number may be ported or WhatsApp installed later) |
| **User intent (opt-out / DND)** | Person asked to stop, or blocked the business | **Only the person** — never by an operator |

This distinction is load-bearing. An operator clearing a technical suppression is routine housekeeping. An operator clearing an opt-out is overriding a customer's explicit wish, and in most jurisdictions that is the thing regulators fine you for. **The two must not share a "clear suppression" button.**

### Opt-out triggers

| Trigger | Detection |
|---|---|
| Reply matching a stop keyword | Inbound message text matched against a per-account, per-language keyword list (`STOP`, `UNSUBSCRIBE`, `OPT OUT`, plus local-language equivalents — this matters for an India-first product) |
| Template quick-reply "Stop promotions" | Button payload — the reliable path, since Meta requires opt-out affordances on marketing templates |
| User blocks the business | Inferred from repeated delivery failure after prior success, plus quality-rating signals. Treat as opt-out, not technical. |
| Operator/importer marks Do-Not-Contact | Explicit flag at CSV import or on the contact record |

Keyword matching must be **per-account and per-language configurable**, not a hardcoded English list. A Telugu or Hindi "stop" must work.

### Model

```
contacts
  + consent_state       TEXT NOT NULL DEFAULT 'unknown'
        CHECK (consent_state IN ('unknown','opted_in','opted_out','do_not_contact'))
  + opted_out_at        TIMESTAMPTZ
  + opt_out_source      TEXT   -- keyword | quick_reply | inferred_block | operator | import
  + opt_out_evidence    TEXT   -- the actual inbound message id, for disputes
```

`consent_state` is **separate from `deliverability_state`** (§4). A number can be technically reachable and opted out; both must block a send, for different reasons, with different messages and different reversal rules.

### Scope

Opt-out is **per account**, not global. A person opting out of one client's marketing has not opted out of another's — they are different businesses with different relationships. Enforce with `account_id` scoping like everything else.

Category scoping (opt out of marketing but still receive order updates) is the correct long-term model and matches how Meta categorises templates. **Design the column to allow it; do not build it now** — `opt_out_scope` defaulting to `all`.

### Plain-English messages

| State | Shown to user |
|---|---|
| `opted_out` | "This person asked to stop receiving messages. You can't message them until they contact you again." |
| `do_not_contact` | "This contact is marked do-not-contact and has been skipped." |
| Audience excluded | "38 contacts skipped — they've opted out of messages." |

### Rules

```
Opt-out blocks marketing/broadcast sends unconditionally
Opt-out is NOT clearable by any operator — only a new inbound message from
  that person, or an explicit re-opt-in, restores sending
Re-opt-in must be evidenced (inbound message id recorded)
Opt-out check runs BEFORE credit reservation — an opted-out number
  never consumes credits
Opt-out survives contact re-import — matching by phone, never reset by CSV
Opt-out is evidence for Meta compliance cases (SUPER_ADMIN_CONSOLE §7)
```

That second-to-last rule is the one that gets missed: a CSV re-import that silently resets consent state re-spams everyone who opted out. Match on phone number and preserve consent on import, always.

---

## 4. Number suppression — data model

```
contacts
  + deliverability_state   TEXT NOT NULL DEFAULT 'unknown'
        CHECK (deliverability_state IN
               ('unknown','reachable','suppressed','manually_cleared'))
  + suppressed_at          TIMESTAMPTZ
  + suppressed_reason_code TEXT          -- e.g. '131026'
  + suppression_strikes    INTEGER NOT NULL DEFAULT 0

contact_delivery_events     -- append-only audit; never mutate
  id · account_id · contact_id · occurred_at
  error_code · disposition · raw_error (jsonb) · message_ref · broadcast_id

broadcast_recipients
  + error_code             TEXT          -- NEW: alongside existing error_message
  + disposition            TEXT
  + attempt_count          INTEGER NOT NULL DEFAULT 0
  + next_attempt_at        TIMESTAMPTZ

meta_error_codes            -- the §3 table as editable data
  code (PK) · disposition · layman_message · operator_hint
  · retry_max · retry_base_delay_seconds · updated_at
```

Every table carries `account_id` and is filtered by it in infrastructure SQL, per the architecture guard.

### State machine

```
unknown ──first success──────────────→ reachable
unknown ──PERMANENT_NUMBER───────────→ suppressed
reachable ──PERMANENT_NUMBER─────────→ suppressed
suppressed ──operator override───────→ manually_cleared  (strikes reset to 0)
manually_cleared ──PERMANENT_NUMBER──→ suppressed        (immediate; no second grace)
```

**Immediate suppression on a hard code** (`131026`, `131021`) — one occurrence is enough; these are definitive. The `suppression_strikes` counter exists for future ambiguous codes and for `manually_cleared` numbers that fail again, not to soften the hard cases.

### Enforcement points

Suppression is worth nothing if it is only advisory. Enforce at three layers:

1. **Audience build** — broadcast recipient selection excludes `deliverability_state = 'suppressed'`. Show the operator *"142 contacts excluded — these numbers can't receive WhatsApp messages"* with a link to review.
2. **Pre-send guard** — re-check immediately before dispatch. A number may have been suppressed by another campaign running concurrently. **Critically: this check runs before the credit reservation**, so a suppressed number never consumes credits.
3. **Single-send UI** — inbox and manual send show a blocking state with the plain-English reason and an explicit "send anyway" override for owners/admins only.

### Operator override

Suppression must be reversible — numbers get ported, people install WhatsApp. Provide: a filterable suppressed-contacts list, per-contact reason and history, single and bulk "clear suppression", and an audit entry for every clear (who, when, why). A cleared number that immediately fails again re-suppresses with no grace period.

---

## 4b. Where the plain-English message actually appears

A good message table is worthless if the user never sees it. Every failure must surface where the user is already looking, in their words — never Meta's.

| Surface | What the user sees |
|---|---|
| **Broadcast report** | Failures grouped **by reason**, not a flat list of 200 rows: *"142 couldn't receive WhatsApp messages · 38 opted out · 12 need an approved template · 8 will retry automatically"*. Each group expandable to the contacts. |
| **Contact detail** | A status line with the reason and date: *"Can't receive WhatsApp messages — stopped sending on 14 Mar."* |
| **Inbox / single send** | Composer blocked with the reason inline, before the user types. Not an error after hitting send. |
| **Audience preview** | Before sending: *"3,142 recipients · 180 will be skipped (can't receive / opted out)"* — so the number they see is the number that goes out. |
| **Notification** | `PERMANENT_CONFIG` failures notify the account owner, since only they can fix a token, template or billing problem. |
| **Suppressed contacts list** | Filterable, with reason, date and evidence. |

### Two message fields, not one

Each code carries both `layman_message` (customer-facing, no jargon, no codes) and `operator_hint` (what to actually do about it, for the account owner and the platform console). *"This template is paused because of poor quality ratings"* is the message; *"Meta paused template X on date Y — quality rating dropped to RED; edit or replace"* is the hint.

Never show the raw Meta string or the numeric code in normal UI. Keep both in the record and expose them in a "technical details" disclosure and in the platform console — support needs them, users do not.

### Writing rules

```
No Meta error codes in user-facing text
No jargon: no "WABA", "hydrated", "parameter", "subcode", "24-hour window"
Say what happened, then what happens next — and whether the user must act
Never blame the user for Meta-side problems
Localise: message text is translatable (next-intl is already in the stack)
```

---

## 5. Where this lives in the architecture

```
WhatsAppProvider (MetaWhatsAppProvider)
  └─ parses Meta error envelope → MetaError { code, subcode, raw }
       │
       ▼
MetaErrorClassifier            (domain — pure, no vendor imports, fully unit-testable)
  └─ MetaError → { disposition, laymanMessage, operatorHint, retryPolicy }
       │
       ├── TRANSIENT / THROTTLED → queue requeue with computed delay
       ├── PERMANENT_CONFIG      → pause run + operator alert + notification
       └── PERMANENT_NUMBER      → ContactDeliverabilityService.suppress(...)
                                    → contact_delivery_events (append)
                                    → contacts.deliverability_state = 'suppressed'
```

`MetaErrorClassifier` is **domain-layer and vendor-free** — it takes a code and returns a decision. That keeps the highest-risk logic in the most testable place, and satisfies the architecture guard (no SDK imports outside `providers/`).

Errors also arrive **asynchronously via webhook** (`message.status = failed` carries an `errors[]` array), not only from the send call's HTTP response. Both paths must feed the same classifier — a design failure here is the most likely way suppression silently does not work in production.

---

## 6. Test requirements

```
Every code in §3 classifies to its expected disposition
Unknown code → TRANSIENT, never PERMANENT_NUMBER
131049 → THROTTLED, never PERMANENT_NUMBER          (regression guard)
131009 with non-phone parameter → PERMANENT_CONFIG  (not suppression)
Suppressed contact is excluded from audience build
Suppressed contact consumes zero credits (pre-send guard fires first)
Webhook-delivered failure suppresses identically to send-response failure
Duplicate webhook for the same message suppresses once, logs once (idempotent)
Suppression is tenant-scoped — account A cannot see or affect account B's
Opt-out survives CSV re-import (matched by phone, consent preserved)
Opt-out is not clearable by any operator role
Opt-out is per account — opting out of A does not affect B
Stop-keyword matching works in configured non-English languages
No user-facing string contains a numeric Meta code or raw Meta text
```

---

## 7. Build gate

`MetaErrorClassifier`, the code table, and the suppression state machine have **no dependency on the DB choice or the Meta commercial gate** — they are pure domain logic plus three columns. They can be specified and unit-tested now.

The **credit-interaction** part (§4 enforcement point 2 — suppression preventing a reservation) touches reservation code, which `DO_NOT_BUILD_YET.md` gates behind both hard gates. Build the classifier and suppression first; wire the credit guard when the gates clear.
