import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

async function find(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? find(resolve(path, entry.name))
    : resolve(path, entry.name).endsWith("cross-platform-fixture.json") ? [resolve(path, entry.name)] : []))).flat();
}

const expected = Number(process.env.EXPECTED_FIXTURE_COUNT);
if (!Number.isSafeInteger(expected) || expected < 1) throw new Error("Invalid expected fixture count");
const files = await find(process.argv[2] ?? "compatibility-evidence");
if (files.length !== expected) throw new Error(`Expected ${expected} fixture artifacts, received ${files.length}`);
const values = await Promise.all(files.map((file) => readFile(file, "utf8")));
if (new Set(values).size !== 1) throw new Error(`Cross-platform deterministic fixtures differ: ${files.join(", ")}`);
process.stdout.write(`Matched ${files.length} deterministic fixture artifacts\n`);
