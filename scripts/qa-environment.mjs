import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import process from "node:process";
import { dirname, join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";

export const QA_STATE_PATH = join(".pawsh-qa", "last-run.json");
// 3, not 2: a state file written before the source fingerprint existed records a run whose
// identity was HEAD alone, and HEAD alone cannot say which code was validated. Refusing to load
// those files is what stops a pre-upgrade run being resumed on the old, weaker evidence.
export const QA_ENVIRONMENT_SCHEMA_VERSION = 3;
export const QA_ORCHESTRATOR_VERSION = "3";
const VALID_SECRET = "validation-only-secret-at-least-32-characters";
const DEFAULT_DATABASE_URL = "postgres://pawsh:pawsh-local-only@127.0.0.1:55432/pawsh?options=-c%20TimeZone%3DUTC";
const DEFAULT_APP_ORIGIN = "http://127.0.0.1:3000";
/** Everything a build stage writes. Both are gitignored, so neither reaches the source identity. */
const BUILD_OUTPUTS = ["dist", join("packages", "domain", "dist")];

function git(args, options = {}) {
  // 64 MiB: `git diff HEAD` on a large working tree can exceed the 1 MiB default, and an
  // exceeded buffer throws - which the callers below deliberately turn into "unknown", never
  // into "unchanged".
  // stderr is discarded rather than forwarded: on a Windows checkout with `core.autocrlf` on,
  // `git diff` and `git hash-object` print a line-ending warning per file, which would bury
  // every QA run and every test run that computes an identity in hundreds of lines of noise.
  // Nothing here reads git's stderr - a failure is a non-zero exit, which throws, and the
  // callers turn that into an identity that matches nothing.
  return execFileSync("git", args, {
    encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"], ...options
  });
}

function localSha() {
  try { return git(["rev-parse", "HEAD"]).trim(); }
  catch { return "unknown"; }
}

/**
 * What code this run is actually about.
 *
 * WHY HEAD IS NOT ENOUGH, AND WHY THIS IS THE FIX. `qa:resume` reuses the stages a previous run
 * passed and reports them as passed without executing them. Its only compatibility check was
 * `git rev-parse HEAD`, which does not move when a file is edited - so editing a source file,
 * or ten, and then resuming produced a report that said "passed" about code no stage in either
 * run had ever seen. That is the one failure mode a QA orchestrator must not have.
 *
 * The identity is HEAD plus the CONTENT of everything that differs from it: `git diff HEAD`
 * covers every tracked modification, staged or not, including deletions and mode changes, and
 * the untracked files are named and hashed by `git hash-object`, which skips everything
 * `.gitignore` excludes - so `dist/`, `node_modules/` and `.pawsh-qa/` are correctly absent. Two
 * trees with the same identity contain the same source; a single edited character changes it.
 *
 * IT FAILS CLOSED. If git cannot be run, or the diff cannot be read, the identity is a fresh
 * random value. That compares equal to no recorded run, so the consequence is a refused resume
 * rather than a resume based on an identity nobody could verify.
 */
export function workingTreeIdentity(env = process.env) {
  if (env.PAWSH_QA_SOURCE_FINGERPRINT) {
    return {
      sourceFingerprint: env.PAWSH_QA_SOURCE_FINGERPRINT,
      dirtyWorkingTree: env.PAWSH_QA_WORKING_TREE === "dirty"
    };
  }
  try {
    const head = git(["rev-parse", "HEAD"]).trim();
    const tracked = git(["diff", "HEAD"]);
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0").filter(Boolean).sort();
    const blobs = untracked.length
      ? git(["hash-object", "--stdin-paths"], { input: `${untracked.join("\n")}\n` })
      : "";
    const digest = createHash("sha256")
      .update(head).update("\0")
      .update(tracked).update("\0")
      .update(untracked.join("\n")).update("\0")
      .update(blobs)
      .digest("hex");
    return {
      sourceFingerprint: digest,
      dirtyWorkingTree: tracked.length > 0 || untracked.length > 0
    };
  } catch {
    return { sourceFingerprint: `unverifiable-${randomUUID()}`, dirtyWorkingTree: true };
  }
}

async function hashDirectory(hash, root, directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return false; }
  let present = false;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { present = await hashDirectory(hash, root, path) || present; continue; }
    if (!entry.isFile()) continue;
    // Path and size before content, so a file moved or truncated changes the digest even if some
    // other file happens to absorb its bytes.
    const info = await stat(path);
    hash.update(relative(root, path).split(sep).join("/")).update("\0");
    hash.update(String(info.size)).update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
    present = true;
  }
  return present;
}

/**
 * What the compiled output currently is.
 *
 * `static` runs `lint`, `typecheck` and `build`; every later stage that starts the application
 * from `dist/` is standing on that build. A resume that skips `static` is therefore reusing a
 * build it did not make, and "the source is unchanged" does not by itself establish that the
 * build on disk came from that source - the directory may have been rebuilt from something else,
 * partially deleted, or never produced at all. Hashing it makes the claim checkable.
 *
 * `absent` is a real value and is deliberately not an error: it is what a resume must see and
 * refuse when the build it was going to reuse is simply not there.
 */
export async function buildIdentity(env = process.env, outputs = BUILD_OUTPUTS) {
  if (env.PAWSH_QA_BUILD_FINGERPRINT) return env.PAWSH_QA_BUILD_FINGERPRINT;
  const hash = createHash("sha256");
  let present = false;
  for (const output of outputs) {
    hash.update(output).update("\0");
    present = await hashDirectory(hash, output, output) || present;
  }
  return present ? hash.digest("hex") : "absent";
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
  const tree = workingTreeIdentity(env);
  return {
    sha: env.PAWSH_QA_SHA || localSha(),
    branch: env.PAWSH_QA_BRANCH || "main",
    fingerprint: environmentFingerprint(env),
    sourceFingerprint: tree.sourceFingerprint,
    dirtyWorkingTree: tree.dirtyWorkingTree
  };
}

export async function loadQaState(path = QA_STATE_PATH) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    // `sourceFingerprint` is required, not optional. A state file that does not carry one was
    // written by an orchestrator whose only identity was HEAD, and treating its stages as
    // reusable is exactly the trust this change removes.
    if (!value || value.schemaVersion !== QA_ENVIRONMENT_SCHEMA_VERSION || typeof value.sha !== "string" || typeof value.environmentFingerprint !== "string" || typeof value.sourceFingerprint !== "string") return null;
    return value;
  } catch { return null; }
}

export async function writeQaState(state, path = QA_STATE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const allowed = ["sha", "branch", "mode", "startedAt", "completedAt", "overallStatus", "lastCompletedStage", "firstFailedStage", "failureClassification", "cleanupStatus", "environmentFingerprint", "sourceFingerprint", "dirtyWorkingTree", "buildFingerprint", "orchestratorVersion"];
  const safeState = Object.fromEntries(allowed.filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
  await writeFile(temp, `${JSON.stringify({ schemaVersion: QA_ENVIRONMENT_SCHEMA_VERSION, ...safeState })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}
