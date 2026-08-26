import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHash, normalizeLineEndings, withoutVariableFields } from "../../src/domain/canonical.js";
import { safePdfFilename } from "../../src/domain/filenames.js";
import { FilesystemDocumentStorage } from "../../src/storage/documents.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("cross-platform deterministic contracts", () => {
  it("normalizes line endings, Unicode, and volatile event fields", () => {
    const lf = "Calm 🐾\nCafé shampoo\n李 Groomer";
    expect(normalizeLineEndings(lf.replaceAll("\n", "\r\n"))).toBe(lf);
    expect(normalizeLineEndings(lf.replaceAll("\n", "\r"))).toBe(lf);
    expect(canonicalHash({ notes: normalizeLineEndings(lf) }))
      .toBe(canonicalHash({ notes: normalizeLineEndings(lf.replaceAll("\n", "\r\n")) }));
    expect(withoutVariableFields({ id: "random", action: "appointment.created", createdAt: "now" }, ["id", "createdAt"]))
      .toEqual({ action: "appointment.created" });
  });

  it.each(["CON", "prn.pdf", "AUX.txt", "NUL", "COM1.pdf", "LPT9", "../escape.pdf", "folder\\escape.pdf"])(
    "prevents unsafe Windows or path-derived PDF filename %s", (value) => {
      const result = safePdfFilename(value);
      expect(result.download).toMatch(/\.pdf$/i);
      expect(result.download).not.toMatch(/[\\/]/);
      expect(result.download).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i);
    }
  );

  it("uses OS-safe paths with spaces and Unicode and rejects traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "Pawsh space Unicode 🐾 "));
    temporary.push(root);
    const storage = new FilesystemDocumentStorage(join(root, "nested documents"));
    const bytes = new TextEncoder().encode("portable evidence");
    await storage.put("business/客户/rabies/évidence", bytes, "application/pdf");
    expect(new TextDecoder().decode((await storage.get("business/客户/rabies/évidence")).bytes)).toBe("portable evidence");
    await expect(storage.put("../../escape", bytes, "application/pdf")).rejects.toMatchObject({ code: "storage_rejected" });
    await storage.delete("business/客户/rabies/évidence");
  });
});

describe("Node native environment-file contract", () => {
  it("uses process environment over .env and last duplicate within the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pawsh-env-"));
    temporary.push(root);
    const file = join(root, ".env");
    await writeFile(file, "PAWSH_PRECEDENCE=file-first\nPAWSH_PRECEDENCE=file-last\n", "utf8");
    const script = "process.stdout.write(process.env.PAWSH_PRECEDENCE ?? '')";
    const fromFile = spawnSync(process.execPath, [`--env-file=${file}`, "--eval", script], { encoding: "utf8" });
    expect(fromFile.status).toBe(0);
    expect(fromFile.stdout).toBe("file-last");
    const fromProcess = spawnSync(process.execPath, [`--env-file=${file}`, "--eval", script], {
      encoding: "utf8", env: { ...process.env, PAWSH_PRECEDENCE: "process" }
    });
    expect(fromProcess.status).toBe(0);
    expect(fromProcess.stdout).toBe("process");
    expect(await readFile(file, "utf8")).not.toContain("process");
  });
});
