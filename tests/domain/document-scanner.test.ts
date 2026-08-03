import { describe,expect,it } from "vitest";
import { DeterministicDocumentScanner,DocumentScannerError } from "../../src/security/document-scanner.js";
import { sha256 } from "../../src/storage/documents.js";

const bytes=new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const digest=sha256(bytes);
const input={documentId:crypto.randomUUID(),objectKey:"quarantine/test",bytes,sha256:digest,size:bytes.byteLength};

describe("deterministic document scanner",()=>{
  it("returns versioned clean and malicious fixture results",async()=>{
    await expect(new DeterministicDocumentScanner().scan(input)).resolves.toMatchObject({
      verdict:"clean",engine:"pawsh-deterministic",signatureVersion:"fixture-v1"
    });
    await expect(new DeterministicDocumentScanner(new Map([[digest,"malicious"]])).scan(input))
      .resolves.toMatchObject({verdict:"malicious",code:"MALWARE_SIMULATED"});
  });
  it.each(["timeout","unavailable"] as const)("simulates %s deterministically",async behavior=>{
    await expect(new DeterministicDocumentScanner(new Map([[digest,behavior]])).scan(input))
      .rejects.toBeInstanceOf(DocumentScannerError);
  });
  it("rejects an input identity mismatch",async()=>{
    await expect(new DeterministicDocumentScanner().scan({...input,size:input.size+1}))
      .rejects.toMatchObject({code:"malformed_response"});
  });
});
