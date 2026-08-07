import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("MVP rabies attachment boundary", () => {
  it("keeps scanner construction out of the application runtime graph", async () => {
    const app = await readFile("src/app.ts", "utf8");
    const routes = await readFile("src/http/routes.ts", "utf8");
    expect(app).not.toMatch(/document-scanner|scan-worker|DocumentScanner/);
    expect(routes).not.toMatch(/processDocumentScans|documentScanner/);
  });

  it("keeps the retired scanner configuration out of the active schema", async () => {
    const config = await readFile("src/config.ts", "utf8");
    expect(config).not.toMatch(/DOCUMENT_SCANNER_ADAPTER|DOCUMENT_SCANNER_ENDPOINT|DOCUMENT_SCANNER_TOKEN/);
  });
});
