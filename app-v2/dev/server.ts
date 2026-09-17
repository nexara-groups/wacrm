/**
 * Dev harness — runs the stack for real so it can be opened and clicked.
 *
 * Real schema (the D1 migration stream, applied to SQLite), real repositories,
 * real domain modules. Nothing here is mocked: the audience preview below is
 * the same `buildAudience` the production broadcast service calls, reading
 * contacts out of an actual `contacts` table.
 *
 * NOT production. sql.js is in-memory and the data is reseeded on every boot;
 * there is no auth in front of these routes. The production runtime is
 * Cloudflare Workers, and the operational store is still undecided
 * (DATABASE_DECISION.md).
 *
 *   npm run dev   →   http://localhost:8787
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { SqlJsDatabaseProvider } from "../db/sqlite/sqljs-database-provider";
import { runMigrations } from "../db/sqlite/run-migrations";
import { buildAudience, formatAudiencePreview } from "@modules/broadcasts/domain/audience";
import { classify } from "@modules/messaging-errors/domain/meta-error-classifier";
import { resolveSeatLimit } from "@modules/organizations/domain/seat-limit";
import { parsePhoneNumber } from "@packages/domain";
import type { Contact } from "@packages/domain";
import { PAGE } from "./page";

const PORT = Number(process.env.PORT ?? 8787);
const ACCOUNT_ID = "acct-demo";

let db: SqlJsDatabaseProvider;

/**
 * Seed contacts covering every audience outcome, so the preview below shows
 * real filtering rather than a happy path: two sendable, one suppressed by a
 * hard Meta code, one opted out by a STOP reply, one do-not-contact.
 */
const SEED: ReadonlyArray<{
  name: string;
  phone: string;
  consent: string;
  deliverability: string;
  reasonCode: string | null;
}> = [
  { name: "Asha Reddy", phone: "+919876543210", consent: "opted_in", deliverability: "reachable", reasonCode: null },
  { name: "Vikram Nair", phone: "+919812345678", consent: "unknown", deliverability: "unknown", reasonCode: null },
  { name: "Priya Sharma", phone: "+919800000001", consent: "unknown", deliverability: "suppressed", reasonCode: "131026" },
  { name: "Rahul Desai", phone: "+919800000002", consent: "opted_out", deliverability: "reachable", reasonCode: null },
  { name: "Meena Iyer", phone: "+919800000003", consent: "do_not_contact", deliverability: "reachable", reasonCode: null },
];

async function seed(): Promise<void> {
  const now = new Date().toISOString();
  const ownerId = randomUUID();

  await db.query(
    `insert into users (user_id, tenant_id, email, display_name, role, created_at, updated_at)
     values ($1, $2, $3, $4, 'owner', $5, $6)`,
    [ownerId, ACCOUNT_ID, "owner@demo.test", "Demo Owner", now, now],
  );
  await db.query(
    `insert into accounts (id, name, owner_user_id, created_at, updated_at) values ($1, $2, $3, $4, $5)`,
    [ACCOUNT_ID, "Demo Account", ownerId, now, now],
  );

  for (const row of SEED) {
    await db.query(
      `insert into contacts
         (id, account_id, phone, display_name, consent_state, deliverability_state,
          suppressed_reason_code, suppression_strikes, opt_out_scope, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, 0, 'all', $8, $9)`,
      [randomUUID(), ACCOUNT_ID, row.phone, row.name, row.consent, row.deliverability, row.reasonCode, now, now],
    );
  }
}

/** Reads contacts through SQL and maps them to the shared `Contact` entity. */
async function loadContacts(): Promise<readonly Contact[]> {
  const { rows } = await db.query<Record<string, string | number | null>>(
    `select id, account_id, phone, display_name, email, consent_state, deliverability_state,
            suppressed_reason_code, suppression_strikes, opt_out_scope, created_at, updated_at
       from contacts
      where account_id = $1
      order by display_name`,
    [ACCOUNT_ID],
  );
  return rows.map(
    (r) =>
      ({
        id: String(r.id),
        accountId: String(r.account_id),
        phoneNumber: String(r.phone),
        displayName: r.display_name === null ? null : String(r.display_name),
        email: r.email === null ? null : String(r.email),
        consentState: String(r.consent_state),
        optedOutAt: null,
        optOutSource: null,
        optOutEvidence: null,
        optOutScope: "all",
        deliverabilityState: String(r.deliverability_state),
        suppressedAt: null,
        suppressedReasonCode: r.suppressed_reason_code === null ? null : String(r.suppressed_reason_code),
        suppressionStrikes: Number(r.suppression_strikes ?? 0),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
      }) as unknown as Contact,
  );
}

const json = (value: unknown): [number, Record<string, string>, string] => [
  200,
  { "content-type": "application/json" },
  JSON.stringify(value, null, 2),
];

async function route(url: URL): Promise<[number, Record<string, string>, string]> {
  switch (url.pathname) {
    case "/":
      return [200, { "content-type": "text/html; charset=utf-8" }, PAGE];

    /** Every contact with the two independent state axes that gate sending. */
    case "/api/contacts": {
      const contacts = await loadContacts();
      return json(
        contacts.map((c) => ({
          name: c.displayName,
          phone: c.phoneNumber,
          consentState: c.consentState,
          deliverabilityState: c.deliverabilityState,
          suppressedReasonCode: c.suppressedReasonCode,
        })),
      );
    }

    /**
     * The audience preview. This is the guarantee that matters: the number
     * shown here is the number that would actually send, and the skipped
     * contacts are grouped by reason rather than listed flat (§4b).
     */
    case "/api/audience": {
      const selection = buildAudience(await loadContacts());
      return json({
        summary: formatAudiencePreview(selection),
        totalConsidered: selection.totalConsidered,
        willSend: selection.includedContactIds.length,
        skippedCount: selection.skippedCount,
        skipped: selection.skipped.map((g) => ({
          reason: g.reason.label,
          count: g.contactIds.length,
        })),
      });
    }

    /** Classify a Meta error code and show the customer-facing copy. */
    case "/api/classify": {
      const code = Number(url.searchParams.get("code") ?? "131026");
      const parameterName = url.searchParams.get("parameter") ?? undefined;
      const result = classify(parameterName ? { code, parameterName } : { code });
      return json({
        code,
        disposition: result.disposition,
        laymanMessage: result.laymanMessage,
        operatorHint: result.operatorHint,
        retryable: result.disposition === "TRANSIENT" || result.disposition === "THROTTLED",
        suppressesNumber: result.disposition === "PERMANENT_NUMBER",
      });
    }

    /** Seat limit resolution across the three configured levels. */
    case "/api/seats": {
      const override = url.searchParams.get("override");
      const plan = url.searchParams.get("plan");
      const { rows } = await db.query<{ default_seat_limit: number }>(
        "select default_seat_limit from platform_settings",
      );
      const platformDefault = Number(rows[0]?.default_seat_limit ?? 3);
      return json({
        platformDefault,
        planIncludedSeats: plan === null ? null : Number(plan),
        accountOverride: override === null ? null : Number(override),
        resolved: resolveSeatLimit({
          accountSeatLimitOverride: override === null ? null : Number(override),
          planIncludedSeats: plan === null ? null : Number(plan),
          platformDefaultSeatLimit: platformDefault,
        }),
      });
    }

    /** Phone normalisation — the dedup guarantee behind consent-preserving import. */
    case "/api/phone": {
      const raw = url.searchParams.get("raw") ?? "09876543210";
      try {
        return json({ raw, normalised: parsePhoneNumber(raw, "IN") });
      } catch (error) {
        return json({ raw, error: error instanceof Error ? error.message : String(error) });
      }
    }

    default:
      return [404, { "content-type": "application/json" }, JSON.stringify({ error: "not found" })];
  }
}

async function main(): Promise<void> {
  db = await SqlJsDatabaseProvider.create();
  const applied = runMigrations(db);
  await seed();

  createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    route(url)
      .then(([status, headers, body]) => {
        res.writeHead(status, headers);
        res.end(body);
      })
      .catch((error: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  }).listen(PORT, () => {
    console.log(`\n  Nexara WACRM dev harness`);
    console.log(`  ${applied.length} migrations applied · ${SEED.length} contacts seeded`);
    console.log(`\n  http://localhost:${PORT}\n`);
  });
}

void main();
