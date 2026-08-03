/* global console */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release, type, version } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";

function command(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true
    }).trim();
  } catch {
    return null;
  }
}

async function browserMetadata() {
  try {
    const [{ chromium }, manifestText] = await Promise.all([
      import("playwright"),
      import("node:fs/promises").then(({ readFile }) => readFile(resolve("node_modules/playwright-core/browsers.json"), "utf8"))
    ]);
    const manifest = JSON.parse(manifestText);
    const browser = await chromium.launch({ timeout: 10_000 });
    const chromiumVersion = browser.version();
    await browser.close();
    return {
      chromium: chromiumVersion,
      revisions: Object.fromEntries(manifest.browsers.map((browser) => [browser.name, browser.revision]))
    };
  } catch {
    return null;
  }
}

const output = resolve(process.argv[2] ?? "artifacts/runtime-metadata.json");
const metadata = {
  commitSha: process.env.GITHUB_SHA ?? command("git", ["rev-parse", "HEAD"]),
  workflowRunId: process.env.GITHUB_RUN_ID ?? null,
  runnerImage: process.env.ImageOS ?? null,
  runnerImageVersion: process.env.ImageVersion ?? null,
  os: { platform: platform(), type: type(), release: release(), version: version(), architecture: arch() },
  runtime: {
    node: process.versions.node,
    npm: /npm\/([^\s]+)/.exec(process.env.npm_config_user_agent ?? "")?.[1]
      ?? command(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]),
    icu: process.versions.icu,
    openssl: process.versions.openssl,
    v8: process.versions.v8
  },
  postgres: {
    client: command("psql", ["--version"]),
    server: process.env.DATABASE_URL
      ? command("psql", [process.env.DATABASE_URL, "--tuples-only", "--no-align", "--command", "show server_version"])
      : null
  },
  playwright: command(process.execPath, ["node_modules/@playwright/test/cli.js", "--version"]),
  browsers: await browserMetadata(),
  timezone: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: Intl.DateTimeFormat().resolvedOptions().locale
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
console.log(JSON.stringify(metadata));
