/* global console, fetch, setTimeout */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before readiness (${child.exitCode})\n${output()}`);
    try { if ((await fetch(url)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server readiness timed out\n${output()}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Server shutdown timed out")), 10_000))
  ]);
}

const port = await availablePort();
const storage = await mkdtemp(join(tmpdir(), "pawsh portability 🐾 "));
let stdout = "";
let stderr = "";
const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    DOCUMENT_STORAGE_ADAPTER: "filesystem",
    DOCUMENT_STORAGE_PATH: storage
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (value) => { stdout += value; });
child.stderr.on("data", (value) => { stderr += value; });
try {
  await waitForHealth(`http://127.0.0.1:${port}/health`, child, () => `${stdout}\n${stderr}`);
  child.kill(process.platform === "win32" ? undefined : "SIGTERM");
  await waitForExit(child);
  const verification = createServer();
  await new Promise((resolve, reject) => verification.once("error", reject).listen(port, "127.0.0.1", resolve));
  await new Promise((resolve) => verification.close(resolve));
  console.log(JSON.stringify({ startup: "passed", shutdown: "passed", portReleased: true, port }));
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(storage, { recursive: true, force: true });
}
