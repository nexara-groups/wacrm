/**
 * Pure helpers for `POST /api/media` (`app/api/media/route.ts`) — kept out
 * of the route itself so the MIME allow-list and the byte cap are testable
 * as plain data in/data out, the same split `composer-state.ts`'s header
 * describes for the composer.
 */
import type { MediaKind } from "@modules/whatsapp/domain/whatsapp-provider.interface";

/**
 * Hard upload cap, enforced by the route BEFORE and AFTER reading the body
 * (see the route's header comment for why both checks exist). Set well
 * under Meta's own per-type ceilings (16 MB video/audio/document, 5 MB
 * image, 100 KB sticker) because the number that matters here is not
 * Meta's limit but this app's: on the Cloudflare free tier a request gets a
 * 10ms CPU budget, and reading + re-encoding a large multipart body into a
 * `Blob` for the outbound Meta call is CPU time, not just I/O wait. 5 MB
 * keeps every allowed media kind's typical file well inside that budget
 * without carving out a per-kind limit the operator would have to guess at
 * before they've even picked a file.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Meta Cloud API's documented MIME allow-list, mapped down to the
 * provider port's `MediaKind` (`image | video | audio | document` — no
 * `sticker`: the port has no sticker send path, see the media send route's
 * header comment). Anything not in this table is `null`, never a guess —
 * an unrecognised type is a 422, not a best-effort forward to Meta that
 * fails there instead.
 */
const MIME_TO_MEDIA_KIND: Readonly<Record<string, MediaKind>> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",

  "video/mp4": "video",
  "video/3gpp": "video",

  "audio/aac": "audio",
  "audio/mp4": "audio",
  "audio/mpeg": "audio",
  "audio/amr": "audio",
  "audio/ogg": "audio",

  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.ms-powerpoint": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
  "text/plain": "document",
};

/**
 * Maps a MIME type onto the `MediaKind` Meta expects it to be sent as, or
 * `null` for anything outside the allow-list above. Case-insensitive and
 * strips a `; charset=...` parameter some browsers attach even to binary
 * uploads (e.g. a misbehaving `Content-Type` on a `text/plain` file) —
 * matching only on the type/subtype Meta itself keys off.
 */
export function mimeTypeToMediaKind(mimeType: string): MediaKind | null {
  const base = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  return MIME_TO_MEDIA_KIND[base] ?? null;
}
