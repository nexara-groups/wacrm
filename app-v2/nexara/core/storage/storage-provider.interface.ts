export interface ImageUpload {
  readonly tenantId: string;
  readonly prefix: string;
  readonly contentType: string;
  readonly bytes: ArrayBuffer;
}

export interface StoredMedia {
  readonly key: string;
  readonly url: string;
}

export interface StoredMediaBody {
  readonly body: ReadableStream;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly etag?: string;
}

export interface StorageProvider {
  readonly name: string;
  putImage(input: ImageUpload): Promise<StoredMedia>;
  get(key: string): Promise<StoredMediaBody | null>;
}
