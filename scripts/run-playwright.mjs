/* global URL, setTimeout */
import { spawn } from "node:child_process";
import process from "node:process";
import { waitForHealth } from "./health-readiness.mjs";

const configuredBaseURL = process.env.PAWSH_E2E_BASE_URL;
const baseURL = configuredBaseURL ?? "http://127.0.0.1:3000";
const environment = {
  ...process.env,
  APP_ORIGIN: process.env.APP_ORIGIN ?? new URL(baseURL).origin,
  PAWSH_E2E_BASE_URL: baseURL,
};

function run(command, args) {
  return spawn(command, args, { env: environment, stdio: "inherit" });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

let server;
try {
  if (!configuredBaseURL) {
    server = run(process.execPath, ["--import", "./scripts/load-env.mjs", "--import", "tsx", "src/server.ts"]);
    await waitForHealth(`${baseURL}/health`, server);
  }
  const playwright = run(process.execPath, ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)]);
  process.exitCode = await new Promise((resolve) =>
    playwright.once("exit", (code) => resolve(code ?? 1))
  );
} finally {
  await stop(server);
}
