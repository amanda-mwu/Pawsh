import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const documentationExtensions = new Set([".md", ".mdx", ".txt", ".rst"]);
const knownExecutableExtensions = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".mjs", ".ps1", ".sh", ".sql", ".ts", ".tsx", ".yaml", ".yml"
]);
const sensitiveSourcePatterns = [
  /child_process/, /\bspawn\s*\(/, /\bexec(?:File)?\s*\(/, /\bfork\s*\(/,
  /process\.platform/, /path\.(?:win32|posix)/, /default-browser/, /os\.tmpdir/,
  /from ["']node:(?:fs|path|os)["']/
];

export function parseNameStatusZ(value) {
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) throw new Error("Missing Git diff status");
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      if (index + 1 >= fields.length) throw new Error("Incomplete renamed/copied path record");
      entries.push({ status, oldPath: fields[index++], path: fields[index++] });
    } else {
      if (index >= fields.length) throw new Error("Incomplete path record");
      entries.push({ status, path: fields[index++] });
    }
  }
  return entries;
}

export function classifyEntries(entries, options = {}) {
  const mode = normalizeMode(options.mode);
  const force = normalizeBoolean(options.forceFull, "force_full");
  const rollback = normalizeBoolean(options.rollbackFull, "rollback_full", true);
  const forcedReasons = [];
  if (mode.full) forcedReasons.push(mode.reason);
  if (force.value) forcedReasons.push(force.reason);
  if (rollback.value) forcedReasons.push(rollback.reason);
  if (!mode.valid || !force.valid || !rollback.valid) forcedReasons.push("malformed_control");

  if (!entries.length) return result("unknown_or_mixed", true, forcedReasons.concat("empty_diff"));
  const categories = new Set();
  const reasons = [...forcedReasons];
  let database = false;
  let browser = false;
  let workflow = false;
  let dependency = false;
  let platformSensitive = false;
  let mobile = false;
  // Server work is skipped only when every changed path is mobile-only.
  let server = false;

  for (const entry of entries) {
    for (const path of [entry.oldPath, entry.path].filter(Boolean)) {
      const category = classifyPath(path, options.readFile);
      categories.add(category.name);
      database ||= category.database;
      browser ||= category.browser;
      workflow ||= category.workflow;
      dependency ||= category.dependency;
      platformSensitive ||= category.platformSensitive;
      mobile ||= category.mobile;
      server ||= category.server;
      if (category.reason) reasons.push(category.reason);
    }
  }

  const executable = [...categories].filter((category) => category !== "documentation_only");
  let changeClass = executable.length === 0 ? "documentation_only"
    : new Set(executable).size === 1 ? executable[0] : "unknown_or_mixed";
  if (changeClass === "unknown_or_mixed") platformSensitive = true;
  const fullMatrix = forcedReasons.length > 0 || platformSensitive || workflow || dependency
    || changeClass === "unknown_or_mixed";
  return {
    changeClass,
    documentationOnly: changeClass === "documentation_only",
    executable: changeClass !== "documentation_only",
    platformSensitive,
    database,
    browser,
    workflow,
    dependency,
    mobile,
    server,
    fullMatrix,
    enforcementLevel: mode.level,
    reasons: trustedReasons(reasons.length ? reasons : [changeClass])
  };
}

function classifyPath(path, readFile = safeReadFile) {
  const normalized = path.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  if (documentationExtensions.has(extension) || lower === "agents.md") return named("documentation_only");
  if (lower.startsWith(".github/")) return named("workflow_or_ci", { workflow: true, platformSensitive: true, reason: "workflow_path" });
  // The mobile app is validated by its own toolchain and cannot affect the server, so a
  // mobile-only change skips server work. Shared packages are consumed by both, so they set
   // `mobile` without clearing `server`. Both sit above the dependency, tooling and database
  // checks below: `apps/mobile/package-lock.json` must not escalate the platform matrix, and a
  // mobile file named `database.ts` must not read as a migration.
  if (lower.startsWith("apps/")) return named("mobile_app", { mobile: true, server: false });
  if (lower.startsWith("packages/")) return named("shared_package", { mobile: true });
  if (lower === "package.json" || /(?:^|\/)(?:package-lock|pnpm-lock|yarn\.lock)/.test(lower)) {
    return named("dependency_change", { dependency: true, platformSensitive: true, reason: "dependency_path" });
  }
  if (/^(?:scripts|bin|tools)\//.test(lower) || /(?:^|\/)(?:dockerfile|compose\.ya?ml|docker-compose)/.test(lower)) {
    return named("platform_sensitive", { platformSensitive: true, reason: "tooling_path" });
  }
  if (lower.startsWith("migrations/") || lower.startsWith("tests/database/")
    || /(?:^|\/)(?:db|database)(?:\/|\.|$)/.test(lower)) {
    return named("database_or_migration", { database: true });
  }
  if (lower.startsWith("public/") || lower.startsWith("tests/browser/") || lower.includes("playwright")) {
    return named("browser_or_ui", { browser: true });
  }
  if (/^(?:src|tests)\//.test(lower)) {
    if (/(?:server|startup|default-browser|storage|filesystem|runtime|process)/.test(lower)) {
      return named("platform_sensitive", { platformSensitive: true, reason: "runtime_path" });
    }
    const content = readFile?.(normalized);
    if (content && sensitiveSourcePatterns.some((pattern) => pattern.test(content.slice(0, 256_000)))) {
      return named("platform_sensitive", { platformSensitive: true, reason: "runtime_primitive" });
    }
    return named("ordinary_executable");
  }
  if (knownExecutableExtensions.has(extension)) return named("unknown_or_mixed", { platformSensitive: true, reason: "unknown_executable" });
  return named("unknown_or_mixed", { platformSensitive: true, reason: "unknown_path" });
}

function named(name, values = {}) {
  return { name, database: false, browser: false, workflow: false, dependency: false, platformSensitive: false, mobile: false, server: true, ...values };
}

function normalizeMode(value = "beta_development") {
  if (value === "beta_development") return { valid: true, full: false, level: value };
  if (value === "beta_release_candidate") return { valid: true, full: true, level: value, reason: "release_candidate" };
  if (value === "scheduled_full_matrix") return { valid: true, full: true, level: value, reason: "scheduled" };
  if (value === "manual_full_matrix") return { valid: true, full: true, level: value, reason: "manual_full" };
  return { valid: false, full: true, level: "unknown", reason: "unknown_mode" };
}

function normalizeBoolean(value, name, absentConservative = false) {
  if (value === true || value === "true") return { valid: true, value: true, reason: name };
  if (value === false || value === "false") return { valid: true, value: false, reason: name };
  if ((value === undefined || value === "") && !absentConservative) return { valid: true, value: false, reason: name };
  if ((value === undefined || value === "") && absentConservative) return { valid: true, value: true, reason: `${name}_absent` };
  return { valid: false, value: true, reason: `${name}_malformed` };
}

function result(changeClass, fullMatrix, reasons) {
  return {
    changeClass, documentationOnly: false, executable: true, platformSensitive: true,
    database: false, browser: false, workflow: false, dependency: false, mobile: true, server: true, fullMatrix,
    enforcementLevel: "unknown", reasons: trustedReasons(reasons)
  };
}

function trustedReasons(reasons) {
  return [...new Set(reasons)].filter(Boolean).slice(0, 12).join(",");
}

function safeReadFile(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

export function gitEntries(base, head, options = {}) {
  const runner = options.runner ?? spawnSync;
  let comparison = base;
  if (options.mergeBase) {
    const merge = runner("git", ["merge-base", base, head], { encoding: "utf8", shell: false });
    if (merge.status !== 0 || !merge.stdout.trim()) throw new Error("merge_base_unavailable");
    comparison = merge.stdout.trim();
  }
  const diff = runner("git", ["diff", "--name-status", "-z", comparison, head], {
    encoding: "utf8", shell: false, maxBuffer: 4 * 1024 * 1024
  });
  if (diff.status !== 0) throw new Error("diff_failed");
  return parseNameStatusZ(diff.stdout);
}

export function comparisonFromEvent(eventName, event, fallbackHead) {
  const head = event.pull_request?.head?.sha ?? event.after ?? fallbackHead;
  const base = event.pull_request?.base?.sha ?? event.before;
  if (!head || !base || /^0+$/.test(base)) throw new Error("comparison_sha_unavailable");
  return { base, head, mergeBase: eventName === "pull_request" };
}
