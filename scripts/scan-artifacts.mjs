/* global console, process */
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const roots = process.argv.slice(2).map((value) => resolve(value));
const forbidden = [
  /authorization\s*[:=]\s*(?:bearer|basic)\s+\S+/i,
  /cookie\s*[:=]\s*[^\s]+/i,
  /session_secret\s*[:=]/i,
  /smtp_pass\s*[:=]/i,
  /document_storage_secret_access_key\s*[:=]/i,
  /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];

async function files(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path);
  return (await Promise.all(entries.map((entry) => files(resolve(path, entry))))).flat();
}

for (const root of roots) {
  let candidates;
  try { candidates = await files(root); }
  catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  for (const file of candidates) {
    const contents = await readFile(file);
    if (contents.includes(0)) continue;
    const text = contents.toString("utf8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) throw new Error(`Artifact redaction failed for ${file}: ${pattern.source}`);
    }
  }
}
console.log(`Artifact redaction passed for ${roots.length} root(s)`);
