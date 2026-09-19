/**
 * TEMPORARY manual verification script — NOT part of the deliverable.
 *
 * `proxy.ts` blocks every `/api/**` request with no session cookie,
 * `/api/webhooks/whatsapp` included (see the delivery report), so a real
 * HTTP request through `next dev` on port 8824 gets a 401 from the proxy
 * before the route handler ever runs. This file invokes the actual GET/POST
 * exports of `app/api/webhooks/whatsapp/route.ts` directly — same code, same
 * real sql.js-backed database via `getBaseServices()`, same real HMAC
 * verification — to capture what the route itself does, bypassing only the
 * edge proxy this task explicitly forbids editing.
 *
 * Run with: npx vitest run --config vitest.manual.config.ts
 * Deleted (along with vitest.manual.config.ts) after capturing the output.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, it, beforeAll } from "vitest";
import { DEMO_PHONE_NUMBER_ID } from "./lib/seed/whatsapp";

process.env.META_APP_SECRET = "manual-verify-app-secret";
process.env.META_WEBHOOK_VERIFY_TOKEN = "manual-verify-token";

const BASE = "http://localhost/api/webhooks/whatsapp";

function sign(raw: string): string {
  return `sha256=${createHmac("sha256", process.env.META_APP_SECRET!).update(raw).digest("hex")}`;
}

async function dump(label: string, res: Response) {
  const body = await res.clone().text();
  // eslint-disable-next-line no-console
  console.log(`\n--- ${label} ---\nstatus: ${res.status}\nbody: ${body}\n`);
}

describe("MANUAL: webhook route, direct invocation", () => {
  beforeAll(async () => {
    // Force the module-level env vars to be read fresh for this process.
  });

  it("GET verify handshake — succeeds with the right token", async () => {
    const { GET } = await import("./app/api/webhooks/whatsapp/route");
    const url = `${BASE}?hub.mode=subscribe&hub.verify_token=manual-verify-token&hub.challenge=CHALLENGE_XYZ`;
    const res = GET(new NextRequest(url));
    await dump("GET handshake — correct token", res);
  });

  it("GET verify handshake — fails with the wrong token", async () => {
    const { GET } = await import("./app/api/webhooks/whatsapp/route");
    const url = `${BASE}?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=CHALLENGE_XYZ`;
    const res = GET(new NextRequest(url));
    await dump("GET handshake — wrong token", res);
  });

  it("POST — correctly signed webhook is accepted, redelivery is deduped, tampered body is rejected", async () => {
    const { POST } = await import("./app/api/webhooks/whatsapp/route");

    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550001111", phone_number_id: DEMO_PHONE_NUMBER_ID },
                contacts: [{ profile: { name: "Manual Tester" }, wa_id: "919876543210" }],
                messages: [
                  {
                    id: "wamid.MANUALTEST0001",
                    from: "919876543210",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "hello from a manual capture" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(payload);
    const goodSig = sign(raw);

    // 1. Correct signature -> accepted, processed.
    const req1 = new NextRequest(BASE, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": goodSig },
      body: raw,
    });
    const res1 = await POST(req1);
    await dump("POST #1 — correct signature (first delivery)", res1);

    // 2. Tampered body, SAME signature -> rejected (signature no longer matches).
    const tampered = raw.replace("hello from a manual capture", "TAMPERED PAYLOAD");
    const req2 = new NextRequest(BASE, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": goodSig },
      body: tampered,
    });
    const res2 = await POST(req2);
    await dump("POST #2 — SAME signature, TAMPERED body", res2);

    // 3. Missing signature header -> rejected.
    const req3 = new NextRequest(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    const res3 = await POST(req3);
    await dump("POST #3 — missing signature header", res3);

    // 4. Exact same body + signature redelivered -> accepted (200) but deduped, not reprocessed.
    const req4 = new NextRequest(BASE, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": goodSig },
      body: raw,
    });
    const res4 = await POST(req4);
    await dump("POST #4 — exact redelivery of #1 (idempotency)", res4);
  });
});
