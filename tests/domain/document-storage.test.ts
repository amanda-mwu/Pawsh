import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  DocumentStorageError, FilesystemDocumentStorage, MemoryDocumentStorage, S3DocumentStorage, sha256
} from "../../src/storage/documents.js";

describe("pet document storage adapters", () => {
  it("keeps memory objects immutable and isolated", async () => {
    const storage = new MemoryDocumentStorage();
    const bytes = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
    await storage.put("business/a/document/1", bytes, "application/pdf");
    await expect(storage.put("business/a/document/1", bytes, "application/pdf")).rejects.toMatchObject({
      code: "storage_conflict"
    });
    const loaded = await storage.get("business/a/document/1");
    expect(new TextDecoder().decode(loaded.bytes)).toBe("%PDF-1.4\n%%EOF\n");
    expect(await storage.head("business/a/document/1")).toEqual({ size: bytes.byteLength });
    expect(sha256(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses private immutable S3 creation with encryption and normalized failures", async () => {
    const commands: unknown[] = [];
    const client = { send: async (command: unknown) => { commands.push(command); return {}; } } as unknown as S3Client;
    const storage = new S3DocumentStorage("private-bucket", { region: "us-west-2", sse: "AES256" }, client);
    await storage.put("business/a/document/1", new Uint8Array([1,2,3]), "application/pdf");
    expect(commands[0]).toBeInstanceOf(PutObjectCommand);
    expect((commands[0] as PutObjectCommand).input).toMatchObject({
      Bucket: "private-bucket", Key: "business/a/document/1", IfNoneMatch: "*",
      ContentType: "application/pdf", ServerSideEncryption: "AES256"
    });

    const conflictClient = {
      send: async () => { throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }; }
    } as unknown as S3Client;
    await expect(new S3DocumentStorage("private-bucket", { region: "us-west-2", sse: "AES256" }, conflictClient)
      .put("key", new Uint8Array([1]), "application/pdf")).rejects.toMatchObject({ code: "storage_conflict" });
  });

  it("atomically creates filesystem objects without filename path authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "pawsh-documents-"));
    const storage = new FilesystemDocumentStorage(root);
    const bytes = new TextEncoder().encode("private evidence");
    await storage.put("business/a/document/1", bytes, "application/pdf");
    expect(await readFile(join(root, "business", "a", "document", "1"), "utf8")).toBe("private evidence");
    await expect(storage.put("business/a/document/1", bytes, "application/pdf")).rejects.toBeInstanceOf(DocumentStorageError);
    await expect(storage.put("../../escape", bytes, "application/pdf")).rejects.toMatchObject({ code: "storage_rejected" });
  });
});
