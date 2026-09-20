import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, mimeTypeToMediaKind } from "./media-upload";

describe("mimeTypeToMediaKind", () => {
  it.each([
    ["image/jpeg", "image"],
    ["image/png", "image"],
    ["image/webp", "image"],
    ["video/mp4", "video"],
    ["video/3gpp", "video"],
    ["audio/aac", "audio"],
    ["audio/mp4", "audio"],
    ["audio/mpeg", "audio"],
    ["audio/amr", "audio"],
    ["audio/ogg", "audio"],
    ["application/pdf", "document"],
    ["application/msword", "document"],
    ["application/vnd.ms-excel", "document"],
    ["application/vnd.ms-powerpoint", "document"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "document",
    ],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "document",
    ],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "document",
    ],
    ["text/plain", "document"],
  ] as const)("maps %s -> %s", (mime, kind) => {
    expect(mimeTypeToMediaKind(mime)).toBe(kind);
  });

  it("is case-insensitive", () => {
    expect(mimeTypeToMediaKind("IMAGE/JPEG")).toBe("image");
  });

  it("ignores a trailing charset parameter", () => {
    expect(mimeTypeToMediaKind("text/plain; charset=utf-8")).toBe("document");
  });

  it("never offers sticker — the provider port has no sticker MediaKind", () => {
    expect(mimeTypeToMediaKind("image/webp")).not.toBe("sticker");
  });

  it("returns null for an unrecognised type rather than guessing", () => {
    expect(mimeTypeToMediaKind("application/zip")).toBeNull();
    expect(mimeTypeToMediaKind("")).toBeNull();
    expect(mimeTypeToMediaKind("image/gif")).toBeNull();
  });
});

describe("MAX_UPLOAD_BYTES", () => {
  it("is 5 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
  });
});
