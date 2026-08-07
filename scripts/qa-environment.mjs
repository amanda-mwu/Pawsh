import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import process from "node:process";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { URL } from "node:url";

export const QA_STATE_PATH = join(".pawsh-qa", "last-run.json");
const VALID_SECRET = "validation-only-secret-at-least-32-characters";

function localSha() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 }).trim(); }
  catch { return "unknown"; }
}

export function createPlaywrightQaEnvironment(parent = process.env) {
  if (parent.NODE_ENV && parent.NODE_ENV !== "test") throw new Error("QA Playwright environment requires NODE_ENV=test");
  if (parent.PAWSH_E2E_MODE && parent.PAWSH_E2E_MODE !== "disposable") throw new Error("QA Playwright environment requires PAWSH_E2E_MODE=disposable");
  if (parent.DOCUMENT_STORAGE_ADAPTER && parent.DOCUMENT_STORAGE_ADAPTER !== "memory") throw new Error("Disposable Playwright QA requires memory document storage");
  if (parent.DOCUMENT_SCANNER_ADAPTER && parent.DOCUMENT_SCANNER_ADAPTER !== "deterministic") throw new Error("Disposable Playwright QA requires the deterministic scanner adapter");
  const env = {
    ...parent,
    NODE_ENV: "test",
    PAWSH_E2E_MODE: "disposable",
    SESSION_SECRET: parent.SESSION_SECRET || VALID_SECRET,
    APP_ORIGIN: parent.APP_ORIGIN || "http://127.0.0.1:3000",
    DOCUMENT_STORAGE_ADAPTER: parent.DOCUMENT_STORAGE_ADAPTER || "memory",
    DOCUMENT_SCANNER_ADAPTER: parent.DOCUMENT_SCANNER_ADAPTER || "deterministic"
  };
  if (env.NODE_ENV !== "test" || env.PAWSH_E2E_MODE !== "disposable") throw new Error("QA Playwright environment must use NODE_ENV=test and PAWSH_E2E_MODE=disposable");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required for disposable Playwright QA");
  if (!/^postgres(?:ql)?:\/\/(?:[^@]+@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(env.DATABASE_URL)) throw new Error("Disposable Playwright QA requires a loopback DATABASE_URL");
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(env.APP_ORIGIN)) throw new Error("Disposable Playwright QA requires a local APP_ORIGIN");
  if (env.SESSION_SECRET.length < 32 || env.SESSION_SECRET.length > 512) throw new Error("SESSION_SECRET must be between 32 and 512 characters for QA");
  if (env.DOCUMENT_STORAGE_ADAPTER !== "memory") throw new Error("Disposable Playwright QA requires memory document storage");
  if (env.DOCUMENT_SCANNER_ADAPTER !== "deterministic") throw new Error("Disposable Playwright QA requires the deterministic scanner adapter");
  return env;
}

export function environmentFingerprint(env) {
  let databaseTarget = "missing";
  try { const url = new URL(env.DATABASE_URL); databaseTarget = `${url.protocol}//${url.hostname}:${url.port || "5432"}${url.pathname}`; } catch { /* validation reports malformed values */ }
  const safe = [env.NODE_ENV, env.PAWSH_E2E_MODE, databaseTarget, env.APP_ORIGIN, env.DOCUMENT_STORAGE_ADAPTER, env.DOCUMENT_SCANNER_ADAPTER, process.versions.node].join("|");
  return createHash("sha256").update(safe).digest("hex");
}

export function currentQaIdentity(env = process.env) {
  return { sha: env.PAWSH_QA_SHA || localSha(), branch: env.PAWSH_QA_BRANCH || "main", fingerprint: environmentFingerprint(env) };
}

export async function loadQaState(path = QA_STATE_PATH) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || value.schemaVersion !== 1 || typeof value.sha !== "string" || typeof value.environmentFingerprint !== "string") return null;
    return value;
  } catch { return null; }
}

export async function writeQaState(state, path = QA_STATE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const allowed = ["sha", "branch", "mode", "startedAt", "completedAt", "overallStatus", "lastCompletedStage", "firstFailedStage", "failureClassification", "cleanupStatus", "environmentFingerprint", "orchestratorVersion"];
  const safeState = Object.fromEntries(allowed.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
  await writeFile(temp, `${JSON.stringify({ schemaVersion: 1, ...safeState })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}
