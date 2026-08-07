import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import process from "node:process";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export const QA_STATE_PATH = join(".pawsh-qa", "last-run.json");
export const QA_ENVIRONMENT_SCHEMA_VERSION = 2;
export const QA_ORCHESTRATOR_VERSION = "2";
const VALID_SECRET = "validation-only-secret-at-least-32-characters";
const DEFAULT_DATABASE_URL = "postgres://pawsh:pawsh-local-only@127.0.0.1:55432/pawsh?options=-c%20TimeZone%3DUTC";
const DEFAULT_APP_ORIGIN = "http://127.0.0.1:3000";

function localSha() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 }).trim(); }
  catch { return "unknown"; }
}

export function validateDisposableQaEnvironment(env) {
  if (env.NODE_ENV !== "test") throw new Error("QA child environment must use NODE_ENV=test");
  if (env.PAWSH_E2E_MODE !== "disposable") throw new Error("QA child environment must use PAWSH_E2E_MODE=disposable");
  if (!env.DATABASE_URL) throw new Error("Disposable QA database could not be constructed safely");
  if (!/^postgres(?:ql)?:\/\/(?:[^@]+@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(env.DATABASE_URL)) throw new Error("Unsafe QA database override: host is not loopback");
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(env.APP_ORIGIN)) throw new Error("Unsafe QA APP_ORIGIN override: origin is not local");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || env.SESSION_SECRET.length > 512) throw new Error("QA SESSION_SECRET must be between 32 and 512 characters");
  if (env.DOCUMENT_STORAGE_ADAPTER !== "memory") throw new Error("Unsafe QA storage override: disposable QA requires memory document storage");
  return env;
}

export function createPlaywrightQaEnvironment(parent = process.env) {
  if (parent.NODE_ENV && !["development", "test"].includes(parent.NODE_ENV)) throw new Error("Unsafe QA NODE_ENV override: use a development shell or test child environment");
  if (parent.PAWSH_E2E_MODE && parent.PAWSH_E2E_MODE !== "disposable") throw new Error("QA Playwright environment requires PAWSH_E2E_MODE=disposable");
  if (parent.DOCUMENT_STORAGE_ADAPTER && parent.DOCUMENT_STORAGE_ADAPTER !== "memory") throw new Error("Disposable Playwright QA requires memory document storage");
  if (parent.PAWSH_E2E_BASE_URL) throw new Error("Repository-owned QA owns its Pawsh server; remove PAWSH_E2E_BASE_URL before running the cascade");
  const inherited = { ...parent };
  for (const key of ["DOCUMENT_SCANNER_ADAPTER", "DOCUMENT_SCANNER_ENDPOINT", "DOCUMENT_SCANNER_TOKEN", "DOCUMENT_STORAGE_PATH", "DOCUMENT_STORAGE_BUCKET", "DOCUMENT_STORAGE_REGION", "DOCUMENT_STORAGE_ENDPOINT", "DOCUMENT_STORAGE_ACCESS_KEY_ID", "DOCUMENT_STORAGE_SECRET_ACCESS_KEY"]) delete inherited[key];
  const env = {
    ...inherited,
    NODE_ENV: "test",
    PAWSH_E2E_MODE: "disposable",
    SESSION_SECRET: parent.SESSION_SECRET || VALID_SECRET,
    DATABASE_URL: parent.DATABASE_URL || DEFAULT_DATABASE_URL,
    APP_ORIGIN: parent.APP_ORIGIN || DEFAULT_APP_ORIGIN,
    DOCUMENT_STORAGE_ADAPTER: parent.DOCUMENT_STORAGE_ADAPTER || "memory",
  };
  return validateDisposableQaEnvironment(env);
}

export function environmentFingerprint(env) {
  const databaseTarget = /^postgres(?:ql)?:\/\/(?:[^@]+@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(env.DATABASE_URL ?? "")
    ? "loopback-disposable" : "invalid";
  const originClass = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(env.APP_ORIGIN ?? "")
    ? "loopback" : "invalid";
  const safe = [QA_ENVIRONMENT_SCHEMA_VERSION, QA_ORCHESTRATOR_VERSION, process.versions.node, env.NODE_ENV, env.PAWSH_E2E_MODE, databaseTarget, originClass, env.DOCUMENT_STORAGE_ADAPTER].join("|");
  return createHash("sha256").update(safe).digest("hex");
}

export function currentQaIdentity(env = process.env) {
  return { sha: env.PAWSH_QA_SHA || localSha(), branch: env.PAWSH_QA_BRANCH || "main", fingerprint: environmentFingerprint(env) };
}

export async function loadQaState(path = QA_STATE_PATH) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || value.schemaVersion !== QA_ENVIRONMENT_SCHEMA_VERSION || typeof value.sha !== "string" || typeof value.environmentFingerprint !== "string") return null;
    return value;
  } catch { return null; }
}

export async function writeQaState(state, path = QA_STATE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const allowed = ["sha", "branch", "mode", "startedAt", "completedAt", "overallStatus", "lastCompletedStage", "firstFailedStage", "failureClassification", "cleanupStatus", "environmentFingerprint", "orchestratorVersion"];
  const safeState = Object.fromEntries(allowed.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
  await writeFile(temp, `${JSON.stringify({ schemaVersion: QA_ENVIRONMENT_SCHEMA_VERSION, ...safeState })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}
