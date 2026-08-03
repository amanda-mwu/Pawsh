import { sha256 } from "../storage/documents.js";

export interface DocumentScanInput {
  documentId: string;
  objectKey: string;
  bytes: Uint8Array;
  sha256: string;
  size: number;
}

export interface DocumentScanResult {
  verdict: "clean" | "malicious";
  engine: string;
  engineVersion: string;
  signatureVersion: string;
  code: string;
  objectKey: string;
  sha256: string;
  size: number;
}

export class DocumentScannerError extends Error {
  constructor(readonly code: "timeout" | "unavailable" | "malformed_response", message: string) {
    super(message); this.name = "DocumentScannerError";
  }
}

export interface DocumentScanner { scan(input: DocumentScanInput): Promise<DocumentScanResult>; }

export class DeterministicDocumentScanner implements DocumentScanner {
  constructor(readonly verdictForDigest: ReadonlyMap<string,string> = new Map()) {}
  async scan(input: DocumentScanInput): Promise<DocumentScanResult> {
    if (sha256(input.bytes) !== input.sha256 || input.bytes.byteLength !== input.size) {
      throw new DocumentScannerError("malformed_response", "Scanner input identity mismatch");
    }
    const behavior = this.verdictForDigest.get(input.sha256) ?? "clean";
    if (behavior === "timeout") throw new DocumentScannerError("timeout", "Deterministic timeout");
    if (behavior === "unavailable") throw new DocumentScannerError("unavailable", "Deterministic outage");
    return { verdict: behavior === "malicious" ? "malicious" : "clean", engine: "pawsh-deterministic",
      engineVersion: "1", signatureVersion: "fixture-v1", code: behavior === "malicious" ? "MALWARE_SIMULATED" : "CLEAN",
      objectKey:input.objectKey,sha256:input.sha256,size:input.size };
  }
}

export class HttpDocumentScanner implements DocumentScanner {
  constructor(private readonly endpoint: string, private readonly bearerToken?: string) {}
  async scan(input: DocumentScanInput): Promise<DocumentScanResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(this.endpoint, { method:"POST",signal:controller.signal,
        headers:{"content-type":"application/json",...(this.bearerToken?{authorization:`Bearer ${this.bearerToken}`}:{})},
        body:JSON.stringify({documentId:input.documentId,objectKey:input.objectKey,sha256:input.sha256,size:input.size}) });
      if(!response.ok) throw new DocumentScannerError("unavailable",`Scanner returned ${response.status}`);
      const value = await response.json() as Partial<DocumentScanResult>;
      if(!["clean","malicious"].includes(value.verdict ?? "") || !value.engine || !value.engineVersion || !value.signatureVersion || !value.code
        || value.objectKey!==input.objectKey || value.sha256!==input.sha256 || value.size!==input.size) {
        throw new DocumentScannerError("malformed_response","Scanner returned an invalid result");
      }
      return value as DocumentScanResult;
    } catch(error) {
      if(error instanceof DocumentScannerError) throw error;
      if((error as Error).name === "AbortError") throw new DocumentScannerError("timeout","Scanner timed out");
      throw new DocumentScannerError("unavailable","Scanner request failed");
    } finally { clearTimeout(timeout); }
  }
}
