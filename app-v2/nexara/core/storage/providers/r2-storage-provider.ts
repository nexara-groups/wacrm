import { AppError } from "../../../shared/errors";
import type { ImageUpload, StorageProvider, StoredMedia, StoredMediaBody } from "../storage-provider.interface";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const EXTENSION_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

interface R2ObjectBody {
  readonly body: ReadableStream;
  readonly etag?: string;
  readonly httpMetadata?: { readonly contentType?: string; readonly cacheControl?: string };
}

export interface R2BucketBinding {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
}

export interface R2StorageConfig {
  readonly bucket: R2BucketBinding;
  readonly publicOrigin: string;
}

export class R2StorageProvider implements StorageProvider {
  readonly name = "r2";
  private readonly publicOrigin: string;

  constructor(private readonly config: R2StorageConfig) {
    const origin = new URL(config.publicOrigin).toString();
    this.publicOrigin = origin.endsWith("/") ? origin : `${origin}/`;
  }

  async putImage(input: ImageUpload): Promise<StoredMedia> {
    const extension = EXTENSION_BY_TYPE[input.contentType as keyof typeof EXTENSION_BY_TYPE];
    if (!extension) throw AppError.validation("Use a JPEG, PNG, or WebP image.");
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw AppError.validation("Image must be between 1 byte and 10 MiB.");
    }
    if (!/^[a-z0-9-]+$/.test(input.tenantId) || !/^[a-z0-9-]+$/.test(input.prefix)) {
      throw AppError.validation("Invalid media key scope.");
    }

    const key = `${input.tenantId}/${input.prefix}/${crypto.randomUUID()}.${extension}`;
    await this.config.bucket.put(key, input.bytes, {
      httpMetadata: { contentType: input.contentType, cacheControl: CACHE_CONTROL },
    });
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return { key, url: new URL(encodedKey, this.publicOrigin).toString() };
  }

  async get(key: string): Promise<StoredMediaBody | null> {
    if (!/^[a-z0-9-]+\/[a-z0-9-]+\/[0-9a-f-]+\.(?:jpg|png|webp)$/.test(key)) return null;
    const object = await this.config.bucket.get(key);
    if (!object) return null;
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      cacheControl: object.httpMetadata?.cacheControl ?? CACHE_CONTROL,
      etag: object.etag,
    };
  }
}
