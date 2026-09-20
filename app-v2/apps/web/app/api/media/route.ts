/**
 * `POST /api/media` — upload a local file to Meta and hand back the media
 * id the send routes (`.../messages/media`) accept as `mediaId`. This is
 * the missing link the composer's file-upload path needs: Meta's send API
 * takes either a fetchable URL or an id from its own `/media` endpoint —
 * there was previously no route that produced that id from a browser
 * upload at all.
 *
 * Authenticated the same way every other app route is: `getContainer()`
 * derives the tenant from the session, never from anything the request
 * body claims.
 *
 * Two constraints below are NOT stylistic and must not be relaxed:
 *
 * 1. A hard 5 MB cap, checked TWICE — once against the `content-length`
 *    header before a single byte is read, and again against the actual
 *    parsed file size afterward, because a client can send any
 *    `content-length` it likes. This app runs on the Cloudflare Workers
 *    free tier, which budgets ~10ms of CPU time per request; reading and
 *    then re-encoding (into the multipart body `MetaWhatsAppProvider`
 *    sends on) a large upload is CPU work, not idle I/O wait, so an
 *    unbounded upload is the one request shape here that can blow that
 *    budget outright. 5 MB sits comfortably under Meta's own per-type
 *    ceilings (documented in `@/lib/media-upload`'s header) — the cap here
 *    is about this app's CPU budget, not Meta's acceptance limit.
 * 2. A closed MIME allow-list (`mimeTypeToMediaKind`, `@/lib/media-upload`,
 *    unit tested there). An unrecognised type is rejected outright — never
 *    forwarded to Meta on a guess, which would just move the same failure
 *    somewhere harder to explain to the operator.
 *
 * Never logs the file's bytes or the account's access token — a caught
 * failure here goes out through `sendFailureResponse`, which only ever
 * surfaces `failure.metaError.message` (already-sanitized), never the
 * request we sent Meta.
 */
import { NextResponse, type NextRequest } from "next/server";
import { AccountId } from "@packages/domain/src/ids";
import { getContainer } from "@/lib/container";
import { authorizeAction } from "@/lib/authorize-route";
import { getWhatsAppContainer } from "@/lib/whatsapp-container";
import { sendFailureResponse } from "@/lib/send-plumbing";
import { MAX_UPLOAD_BYTES, mimeTypeToMediaKind } from "@/lib/media-upload";
import { fail, internalError, ok } from "@/lib/api-response";

const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / (1024 * 1024);

function tooLarge(): NextResponse {
  return fail(
    {
      code: "payload_too_large",
      laymanMessage: `Files larger than ${MAX_UPLOAD_MB} MB can't be uploaded here.`,
    },
    413,
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const authorized = await authorizeAction("media:upload");
    if (!authorized.ok) return authorized.response;

    // Check #1 of 2 — reject before touching the body at all when the
    // client is honest about its size. `content-length` is attacker- or
    // bug-controlled, so this is a fast path, not the guarantee.
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_UPLOAD_BYTES) {
      return tooLarge();
    }

    // Parsing multipart form data is itself what reads the body into
    // memory — there is no cheaper way to learn the field exists first.
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return fail(
        { code: "missing_file", laymanMessage: "Choose a file to upload." },
        400,
      );
    }

    // Check #2 of 2 — the actual parsed size, for the client that lied
    // about (or omitted) `content-length`.
    if (file.size > MAX_UPLOAD_BYTES) {
      return tooLarge();
    }

    const mediaKind = mimeTypeToMediaKind(file.type);
    if (mediaKind === null) {
      return fail(
        {
          code: "unsupported_media_type",
          laymanMessage: `Files of type "${file.type || "unknown"}" aren't supported.`,
        },
        422,
      );
    }

    const { repositories, tenant } = await getContainer();
    const accountId = AccountId(tenant.tenantId);

    // Same account -> config lookup the send routes perform via
    // `resolveSendTarget` — there is no conversation here to hang it off
    // of, so it is inlined rather than importing a helper shaped around a
    // conversationId this route doesn't have.
    const configs = await repositories.whatsappConfig.listByAccount(accountId);
    const config = configs[0];
    if (!config) {
      return sendFailureResponse({ kind: "config_not_found", accountId, phoneNumberId: "" });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    const { service } = await getWhatsAppContainer();
    const result = await service.uploadMedia(accountId, config.phoneNumberId, bytes, file.type, file.name || undefined);
    if (!result.ok) return sendFailureResponse(result.error);

    return ok({ mediaId: result.value.mediaId });
  } catch (error) {
    return internalError(error);
  }
}
