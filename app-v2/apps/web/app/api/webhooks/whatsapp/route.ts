/**
 * `GET/POST /api/webhooks/whatsapp` — Meta's WhatsApp Cloud API webhook.
 *
 * PUBLIC AND UNAUTHENTICATED BY NATURE: this is the one route in the app an
 * attacker can reach with no credentials at all. It must NOT go through
 * `getContainer()` (session-required, throws without one — see
 * `lib/container.ts`) and must NOT require the session cookie `proxy.ts`
 * gates every other route on. See this route's own `KNOWN GAP` comment
 * below re: `proxy.ts`.
 *
 * GET — the verify handshake: Meta calls this once when the webhook URL is
 * configured, with `hub.mode=subscribe`, `hub.verify_token`, and
 * `hub.challenge` query params. Reply with the raw `hub.challenge` body
 * when the token matches (constant-time compare), else 403.
 *
 * POST — the actual event delivery. Every POST's signature is verified
 * BEFORE any JSON parsing (`lib/webhook-signature.ts`'s whole reason for
 * existing: the digest must be computed over the raw bytes). Absent or
 * wrong signature -> reject, never "log and continue". The app secret is
 * read fresh per request and throws if unset — no fallback, no skipping
 * verification (`resolveMetaAppSecret`'s docstring).
 *
 * Idempotency: every parsed event is claimed via
 * `WebhookEventRepositoryPort.claim` (through `WhatsAppService
 * .processWebhookEvent`) before any classify/suppress/log side effect runs
 * — a redelivery of the same event is a no-op (`domain/webhook-idempotency
 * .ts`). This route returns 200 quickly once events are claimed, per
 * Meta's short timeout / aggressive-retry behaviour.
 *
 * Tenant resolution: the payload's `phone_number_id` is looked up via
 * `WhatsAppConfigRepositoryPort.findByPhoneNumberId` — see
 * `lib/whatsapp-container.ts`'s `resolveTenantByPhoneNumberId` docstring
 * for the real gap in that port (it requires an accountId this endpoint,
 * by construction, does not have) and how this app's single seeded tenant
 * sidesteps it without fixing it. An unrecognised `phone_number_id` — no
 * config row, or no `phone_number_id` in the payload at all — is a
 * 200-with-no-action, never a 5xx: Meta retries a 5xx, and retrying
 * something that will never be accepted is a self-inflicted flood.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { WebhookEnvelope } from "@modules/whatsapp/domain/webhook-parser";
import {
  META_SIGNATURE_HEADER,
  resolveMetaAppSecret,
  resolveMetaVerifyToken,
  timingSafeEqualStrings,
  verifyMetaSignature,
} from "@/lib/webhook-signature";
import { getWhatsAppContainer, resolveTenantByPhoneNumberId } from "@/lib/whatsapp-container";

// ---------------------------------------------------------------------------
// Validation — Meta's payload is external input; every request is checked
// against this schema before anything downstream touches it. Deliberately
// permissive on vendor-specific leaf shapes (`.passthrough()` /
// `z.record`) because Meta documents this envelope as evolving and
// `webhook-parser.ts` already treats unknown message/status shapes as
// best-effort, not a validation failure — the schema's job is to guarantee
// the STRUCTURE this route and the parser walk (entry -> changes -> value)
// is actually there, not to re-litigate every leaf field.
// ---------------------------------------------------------------------------

const webhookMetadataSchema = z
  .object({
    display_phone_number: z.string().optional(),
    phone_number_id: z.string().optional(),
  })
  .passthrough();

const webhookChangeValueSchema = z
  .object({
    messaging_product: z.string().optional(),
    metadata: webhookMetadataSchema.optional(),
    contacts: z.array(z.record(z.string(), z.unknown())).optional(),
    messages: z.array(z.record(z.string(), z.unknown())).optional(),
    statuses: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

const webhookChangeSchema = z.object({
  field: z.string(),
  value: webhookChangeValueSchema,
});

const webhookEntrySchema = z.object({
  id: z.string(),
  changes: z.array(webhookChangeSchema),
});

const webhookEnvelopeSchema = z
  .object({
    object: z.string().optional(),
    entry: z.array(webhookEntrySchema).optional(),
  })
  .passthrough();

/** First `phone_number_id` found anywhere in the envelope, or `null`. Meta's
 *  documented shape carries one WABA's events per delivery, so the first
 *  hit is the tenant to resolve against. */
function findPhoneNumberId(envelope: z.infer<typeof webhookEnvelopeSchema>): string | null {
  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes) {
      const id = change.value.metadata?.phone_number_id;
      if (id) return id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET — verify handshake
// ---------------------------------------------------------------------------

export function GET(request: NextRequest): NextResponse {
  const params = request.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  let verifyToken: string;
  try {
    verifyToken = resolveMetaVerifyToken();
  } catch (error) {
    // Fail closed: an unconfigured verify token must not silently pass the
    // handshake. No default, no "skip verification".
    return NextResponse.json(
      { ok: false, error: { code: "misconfigured", message: (error as Error).message } },
      { status: 500 },
    );
  }

  if (mode === "subscribe" && token !== null && challenge !== null && timingSafeEqualStrings(token, verifyToken)) {
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  return NextResponse.json({ ok: false, error: { code: "verification_failed" } }, { status: 403 });
}

// ---------------------------------------------------------------------------
// POST — event delivery
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Raw bytes FIRST, before any JSON parsing — the signature is computed
  // over exactly these bytes. Re-serialising a parsed body would produce a
  // different digest and silently break verification (webhook-signature.ts
  // header + its own test for this exact bug).
  const rawBody = await request.text();

  let appSecret: string;
  try {
    appSecret = resolveMetaAppSecret();
  } catch (error) {
    // Fail closed: never fall back to skipping verification.
    return NextResponse.json(
      { ok: false, error: { code: "misconfigured", message: (error as Error).message } },
      { status: 500 },
    );
  }

  const signatureHeader = request.headers.get(META_SIGNATURE_HEADER);
  if (!verifyMetaSignature(rawBody, signatureHeader, appSecret)) {
    // Reject, do not process — no "log and continue" on a missing or wrong
    // signature.
    return NextResponse.json({ ok: false, error: { code: "invalid_signature" } }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: { code: "invalid_json" } }, { status: 400 });
  }

  const parsedEnvelope = webhookEnvelopeSchema.safeParse(json);
  if (!parsedEnvelope.success) {
    return NextResponse.json({ ok: false, error: { code: "invalid_payload" } }, { status: 400 });
  }

  const phoneNumberId = findPhoneNumberId(parsedEnvelope.data);
  if (!phoneNumberId) {
    // Nothing to resolve a tenant from — 200-with-no-action, not an error:
    // Meta retries non-2xx responses, and there is nothing here that a
    // retry would ever make resolvable.
    return NextResponse.json({ ok: true, action: "ignored", reason: "no_phone_number_id" }, { status: 200 });
  }

  const { repositories, service, demoAccountId } = await getWhatsAppContainer();
  const config = await resolveTenantByPhoneNumberId(repositories, demoAccountId, phoneNumberId);
  if (!config) {
    // Unrecognised phone_number_id — 200-with-no-action per the task's
    // security requirements, never a 5xx (Meta would just keep retrying a
    // delivery this endpoint will never accept).
    return NextResponse.json({ ok: true, action: "ignored", reason: "unknown_phone_number_id" }, { status: 200 });
  }

  const outcomes = await service.processWebhookEvent(config.accountId, parsedEnvelope.data as WebhookEnvelope);

  return NextResponse.json(
    {
      ok: true,
      processed: outcomes.filter((o) => !o.deduped).length,
      deduped: outcomes.filter((o) => o.deduped).length,
    },
    { status: 200 },
  );
}
