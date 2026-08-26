import { createHash } from "node:crypto";
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
  type S3ClientConfig
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { Config } from "../config.js";

export type StorageErrorCode =
  | "storage_unavailable" | "storage_timeout" | "storage_not_found"
  | "storage_conflict" | "storage_integrity_failure" | "storage_rejected" | "storage_internal";

export class DocumentStorageError extends Error {
  constructor(public readonly code: StorageErrorCode, message: string) {
    super(message);
    this.name = "DocumentStorageError";
  }
}

export interface StoredObject {
  bytes: Uint8Array;
  size: number;
}

/**
 * `contentType` is carried through to the object store rather than assumed.
 * The store originally held one kind of file, so the S3 adapter stamped every object
 * `application/pdf`. Appointment photographs are served back to a browser inline, and an
 * object whose stored type disagrees with its bytes is exactly the mismatch `nosniff`
 * cannot save you from.
 */
export interface DocumentStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject>;
  head(key: string): Promise<{ size: number }>;
  delete(key: string): Promise<void>;
}

export class MemoryDocumentStorage implements DocumentStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly contentTypes = new Map<string, string>();
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (this.objects.has(key)) throw new DocumentStorageError("storage_conflict", "Object already exists");
    this.objects.set(key, Uint8Array.from(bytes));
    this.contentTypes.set(key, contentType);
  }
  async get(key: string): Promise<StoredObject> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new DocumentStorageError("storage_not_found", "Object not found");
    return { bytes: Uint8Array.from(bytes), size: bytes.byteLength };
  }
  async head(key: string): Promise<{ size: number }> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new DocumentStorageError("storage_not_found", "Object not found");
    return { size: bytes.byteLength };
  }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
}

export class FilesystemDocumentStorage implements DocumentStorage {
  constructor(private readonly root: string) {}
  private path(key: string): string {
    const root = resolve(this.root);
    const path = resolve(root, ...key.split("/"));
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new DocumentStorageError("storage_rejected", "Invalid storage key");
    }
    return path;
  }
  // The filesystem adapter stores bytes and nothing else; the type is carried by the row that
  // points at the object, and re-deriving it from the file would be guessing.
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    void contentType;
    const finalPath = this.path(key);
    await mkdir(dirname(finalPath), { recursive: true });
    const temporary = `${finalPath}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await link(temporary, finalPath);
      await rm(temporary, { force: true });
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw normalizeStorageError(error);
    }
  }
  async get(key: string): Promise<StoredObject> {
    try {
      const bytes = await readFile(this.path(key));
      return { bytes, size: bytes.byteLength };
    } catch (error) { throw normalizeStorageError(error); }
  }
  async head(key: string): Promise<{ size: number }> {
    try { return { size: (await stat(this.path(key))).size }; }
    catch (error) { throw normalizeStorageError(error); }
  }
  async delete(key: string): Promise<void> {
    try { await rm(this.path(key), { force: true }); }
    catch (error) { throw normalizeStorageError(error); }
  }
}

export class S3DocumentStorage implements DocumentStorage {
  private readonly client: S3Client;
  private readonly sse: "AES256";
  constructor(private readonly bucket: string, options: {
    region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string; sse: "AES256";
  }, client?: S3Client) {
    this.sse = options.sse;
    const clientConfig = {
      region: options.region,
      forcePathStyle: Boolean(options.endpoint),
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ requestTimeout: 30_000, connectionTimeout: 5_000 })
    } as S3ClientConfig;
    if (options.endpoint) clientConfig.endpoint = options.endpoint;
    if (options.accessKeyId && options.secretAccessKey) {
      clientConfig.credentials = { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey };
    }
    this.client = client ?? new S3Client(clientConfig);
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, IfNoneMatch: "*"
        ,ServerSideEncryption: this.sse
      }));
    } catch (error) { throw normalizeStorageError(error); }
  }
  async get(key: string): Promise<StoredObject> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) throw new DocumentStorageError("storage_not_found", "Object not found");
      const bytes = await result.Body.transformToByteArray();
      return { bytes, size: bytes.byteLength };
    } catch (error) { throw normalizeStorageError(error); }
  }
  async head(key: string): Promise<{ size: number }> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (result.ContentLength === undefined) throw new DocumentStorageError("storage_integrity_failure", "Object size unavailable");
      return { size: result.ContentLength };
    } catch (error) { throw normalizeStorageError(error); }
  }
  async delete(key: string): Promise<void> {
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch (error) { throw normalizeStorageError(error); }
  }
}

export function createDocumentStorage(config: Config): DocumentStorage {
  if (config.DOCUMENT_STORAGE_ADAPTER === "memory") {
    if (config.NODE_ENV !== "test") throw new Error("Memory document storage is test-only");
    return new MemoryDocumentStorage();
  }
  if (config.DOCUMENT_STORAGE_ADAPTER === "filesystem") {
    if (config.NODE_ENV !== "development") throw new Error("Filesystem document storage is development-only");
    return new FilesystemDocumentStorage(config.DOCUMENT_STORAGE_PATH!);
  }
  if (config.DOCUMENT_STORAGE_ADAPTER === "s3") {
    const options: { region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string; sse: "AES256" } = {
      region: config.DOCUMENT_STORAGE_REGION!, sse: "AES256"
    };
    if (config.DOCUMENT_STORAGE_ENDPOINT) options.endpoint = config.DOCUMENT_STORAGE_ENDPOINT;
    if (config.DOCUMENT_STORAGE_ACCESS_KEY_ID) options.accessKeyId = config.DOCUMENT_STORAGE_ACCESS_KEY_ID;
    if (config.DOCUMENT_STORAGE_SECRET_ACCESS_KEY) options.secretAccessKey = config.DOCUMENT_STORAGE_SECRET_ACCESS_KEY;
    return new S3DocumentStorage(config.DOCUMENT_STORAGE_BUCKET!, options);
  }
  throw new Error("A supported document storage adapter is required");
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeStorageError(error: unknown): DocumentStorageError {
  if (error instanceof DocumentStorageError) return error;
  const value = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  if (value.$metadata?.httpStatusCode === 404 || value.code === "ENOENT" || value.name === "NoSuchKey") {
    return new DocumentStorageError("storage_not_found", "Object not found");
  }
  if (value.$metadata?.httpStatusCode === 412 || value.code === "EEXIST" || value.name === "PreconditionFailed") {
    return new DocumentStorageError("storage_conflict", "Object already exists");
  }
  if (value.name === "TimeoutError" || value.code === "ETIMEDOUT") {
    return new DocumentStorageError("storage_timeout", "Object storage timed out");
  }
  return new DocumentStorageError("storage_internal", "Object storage operation failed");
}
